// M3: ядро цикла. Замер «срыв при отдалении» (3 попытки), упражнение 1 (5 попыток), сессия: замер «до» → упражнение → замер «после».
import type { Env } from './calibration';
import { BreakDetector, DET_DEFAULTS, DetEvent } from './core/breakDetector';
import { median } from './core/filters';
import { t } from './i18n';
import { FrameInfo, app, persist, zeroValid } from './state';
import { Cancel, captureUntil, h, sheet } from './ui';
import { makeScreen, p, sg } from './wizard';

const MAX_ATTEMPT_SEC = 30;
const RETURN_WAIT_MS = 8000; // после срыва ждём возврат не дольше

interface Attempt {
  broke: boolean;
  breakCm: number;
  angle: number; // вергенция в момент срыва, °
  returned: boolean;
  returnCm: number;
  maxCm: number;
  marked: boolean;
}

function collect(cb: (i: FrameInfo) => void): () => void {
  app.sinks.add(cb);
  return () => app.sinks.delete(cb);
}

const cm = (mm: number) => mm / 10;
const finite = (a: number[]) => a.filter((v) => Number.isFinite(v));
const med = (a: number[]) => (finite(a).length ? median(finite(a)) : NaN);

/** Падение результата (раздел 13 плана): при отдалении меньше, при приближении больше, чем 70 % / 130 % медианы первых трёх. */
function worsened(d: number[], direction: 'away' | 'closer'): boolean {
  const v = finite(d);
  if (v.length < 4) return false;
  const base = median(v.slice(0, 3));
  const last = v[v.length - 1];
  return direction === 'away' ? last < 0.7 * base : last > 1.3 * base;
}

async function runAttempt(env: Env, cancel: Cancel, scene: string, title: string): Promise<Attempt | 'cancel'> {
  const threshold = Math.max(DET_DEFAULTS.thresholdDeg, 3 * (app.zero?.sigma ?? 0)); // порог: не меньше 3° и 3σ шума в покое
  const det = new BreakDetector({ ...DET_DEFAULTS, thresholdDeg: threshold });
  let brk: DetEvent | null = null;
  let ret: DetEvent | null = null;
  let breakWall = 0;
  let maxZ = 0;
  let marked = false;
  const stop = collect((i) => {
    if (Number.isFinite(i.z)) maxZ = Math.max(maxZ, i.z);
    const e = det.push({ t: i.t, value: i.devInst, valid: i.face && i.valid && Number.isFinite(i.devInst), z: i.z });
    if (!e) return;
    if (e.type === 'break' && !brk) {
      brk = e;
      breakWall = performance.now();
      app.pendingEvent = 'break';
    } else if (e.type === 'return' && brk && !ret) {
      ret = e;
      app.pendingEvent = 'return';
    }
  });
  sheet.set(
    title,
    p(app.direction === 'away' ? t.trWaitAway : t.trWaitCloser, 'big'),
    h('div', { class: 'btnrow' }, h('button', { onclick: () => { marked = true; app.pendingEvent = 'mark'; } }, t.trMark)),
  );
  env.recorder.scene = scene;
  const r = await captureUntil({
    prep: 3,
    maxSec: MAX_ATTEMPT_SEC,
    cancel,
    isDone: () => !!brk && (!!ret || performance.now() - breakWall > RETURN_WAIT_MS),
    onEnd: () => (env.recorder.scene = null),
  });
  stop();
  if (r === 'cancel') return 'cancel';
  const b = brk as DetEvent | null;
  const q = ret as DetEvent | null;
  return {
    broke: !!b,
    breakCm: b ? cm(b.z) : NaN,
    angle: b ? b.value : NaN,
    returned: !!q,
    returnCm: q ? cm(q.z) : NaN,
    maxCm: cm(maxZ),
    marked,
  };
}

/** Серия попыток. Возвращает дистанции срыва, см (NaN: срыва не было), или null при отмене. */
async function series(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>, prefix: string, name: string, n: number): Promise<number[] | null> {
  const dists: number[] = [];
  const how = app.direction === 'away' ? t.trHowAway : t.trHowCloser;
  for (let k = 1; k <= n; k++) {
    const ttl = `${name} · ${k}/${n}`;
    const a = await screen(ttl, [p(how), p(t.trStopRule, 'why')], [{ key: 'go', label: t.start2, primary: true }, ...(k > 1 ? [{ key: 'end', label: t.trEnd }] : [])]);
    if (a === 'cancel') return null;
    if (a === 'end') break;
    const r = await runAttempt(env, cancel, `${prefix}_${k}`, ttl);
    if (r === 'cancel') return null;
    dists.push(r.broke ? r.breakCm : NaN);
    const nodes: Node[] = [];
    if (r.broke) {
      nodes.push(h('p', { class: 'big' }, `${t.trBreakAt}: ${r.breakCm.toFixed(0)} см (${sg(r.angle)}°)`));
      nodes.push(p(r.returned ? `${t.trReturnAt}: ${r.returnCm.toFixed(0)} см.` : t.trNoReturn));
    } else nodes.push(h('p', { class: 'big' }, `${t.trNoBreak} ${r.maxCm.toFixed(0)} см`));
    if (worsened(dists, app.direction)) nodes.push(p(t.trDropped, 'warn'));
    const c = await screen(ttl, nodes, worsened(dists, app.direction)
      ? [{ key: 'end', label: t.trFinish, primary: true }, { key: 'next', label: t.trContinue }]
      : [{ key: 'next', label: k < n ? t.next : t.trDone, primary: true }]);
    if (c === 'cancel') return null;
    if (c === 'end') break;
  }
  return dists;
}

async function preflight(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>): Promise<boolean> {
  if (!(await env.ensureCamera())) {
    sheet.set(t.menuTrain, p(t.needCamera));
    return false;
  }
  if (!app.model || !zeroValid() || !app.zero) {
    await screen(t.menuTrain, [p(t.trNeedCalib, 'warn')], [{ key: 'close', label: t.close, primary: true }]);
    return false;
  }
  if (!app.ack) {
    const a = await screen(t.trAckTitle, [p(t.trAck)], [{ key: 'ok', label: t.trAckOk, primary: true }, { key: 'no', label: t.close }]);
    if (a !== 'ok') return false;
    app.ack = Date.now();
    persist();
  }
  return !cancel.cancelled;
}

function summary(name: string, d: number[]): Node[] {
  const m = med(d);
  const got = finite(d).length;
  return [h('p', { class: 'big' }, Number.isFinite(m) ? `${name}: ${m.toFixed(0)} см (${got} из ${d.length})` : `${name}: ${t.trNoBreakShort}`)];
}

/** Быстрый замер: 3 попытки. */
export async function runMeasure(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  });
  const screen = makeScreen(cancel);
  if (!(await preflight(env, cancel, screen))) return sheet.close();
  const d = await series(env, cancel, screen, 'measure', t.trMeasureName, 3);
  if (!d) return;
  for (;;) {
    const a = await screen(t.trMeasureName, [...summary(t.trResult, d), p(t.trTrend)], [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (a === 'csv') env.recorder.download('measure');
    else break;
  }
  sheet.close();
}

/** Сессия: замер «до» (3) → упражнение 1 (5) → замер «после» (3) → итог. */
export async function runTraining(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  });
  const screen = makeScreen(cancel);
  if (!(await preflight(env, cancel, screen))) return sheet.close();

  const before = await series(env, cancel, screen, 'before', t.trBefore, 3);
  if (!before) return;
  const ex = await series(env, cancel, screen, 'ex1', t.trEx1, 5);
  if (!ex) return;
  const after = await series(env, cancel, screen, 'after', t.trAfter, 3);
  if (!after) return;

  const mb = med(before);
  const ma = med(after);
  const nodes: Node[] = [...summary(t.trBefore, before), ...summary(t.trEx1, ex), ...summary(t.trAfter, after)];
  if (Number.isFinite(mb) && Number.isFinite(ma)) {
    const d = ma - mb;
    nodes.push(h('p', { class: 'big' }, `${t.trChange}: ${sg(d, 0)} см (${sg((d / mb) * 100, 0)} %)`));
  }
  nodes.push(p(t.trTrend));
  for (;;) {
    const a = await screen(t.trSessionDone, nodes, [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (a === 'csv') env.recorder.download('session');
    else break;
  }
  sheet.close();
}
