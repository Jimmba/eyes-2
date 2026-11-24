// M3: ядро цикла. Замер «срыв при отдалении» (3 попытки), упражнение 1 (5 попыток), сессия: замер «до» → упражнение → замер «после».
import type { Env } from './calibration';
import { BreakDetector, DET_DEFAULTS, DetEvent } from './core/breakDetector';
import { median } from './core/filters';
import { t } from './i18n';
import { FrameInfo, addHistory, app, lastHistory, persist, zeroValid } from './state';
import type { HistRec } from './profile';
import { Cancel, captureUntil, h, onTap, sheet } from './ui';
import { HoldInit, holdSummary, runHold } from './exercise';
import { fmtDate, makeScreen, p, sg } from './wizard';

const MAX_ATTEMPT_SEC = 60;
const RETURN_WAIT_MS = 20000; // после срыва ждём возврат не дольше

/** Одна попытка («цикл»): срыв и возврат. Расстояния фиксируются и камерой, и вашими отметками. */
interface Attempt {
  broke: boolean;
  breakCm: number; // принятое: камера, а если камера срыв не увидела, ваша отметка
  returnCm: number;
  camBreakCm: number;
  camReturnCm: number;
  markBreakCm: number;
  markReturnCm: number;
  angle: number; // вергенция в момент срыва по камере, °
  maxCm: number;
  boundaryCm: number; // середина между срывом и возвратом (если возврата нет, равна срыву)
}

function collect(cb: (i: FrameInfo) => void): () => void {
  app.sinks.add(cb);
  return () => app.sinks.delete(cb);
}

const cm = (mm: number) => mm / 10;
const finite = (a: number[]) => a.filter((v) => Number.isFinite(v));
const med = (a: number[]) => (finite(a).length ? median(finite(a)) : NaN);
const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(0)} см` : '—');

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
  let camBrk: DetEvent | null = null;
  let camRet: DetEvent | null = null;
  let markBreak = NaN; // мм
  let markReturn = NaN;
  let breakWall = 0;
  let ended = false;
  let recording = false; // касания и события камеры до старта записи (обратный отсчёт) не считаются
  let maxZ = 0;
  const curZ = () => (app.lastInfo && Number.isFinite(app.lastInfo.zs) ? app.lastInfo.zs : NaN);
  const stop = collect((i) => {
    if (!recording) return;
    if (Number.isFinite(i.zs)) maxZ = Math.max(maxZ, i.zs);
    const e = det.push({ t: i.t, value: i.devInst, valid: i.face && i.valid && Number.isFinite(i.devInst), z: i.zs });
    if (!e) return;
    if (e.type === 'break' && !camBrk) {
      camBrk = e;
      if (!breakWall) breakWall = performance.now();
      app.pendingEvent = 'break';
    } else if (e.type === 'return' && camBrk && !camRet) {
      camRet = e;
      app.pendingEvent = 'return';
    }
  });

  // --- экран попытки: живое расстояние, состояние и кнопка, которая меняется по ходу ---
  const live = h('p', { class: 'big' }, '…');
  const status = h('p', { class: 'status' }, t.trStateWait);
  const btn = h('div', { class: 'markpad' }, t.trMark, h('small', null, t.trTapHint));
  const endBtn = h('button', {}, t.trEndAttempt);
  const phase = (): 'fused' | 'broken' | 'done' => {
    const hasBreak = !!camBrk || Number.isFinite(markBreak);
    const hasReturn = !!camRet || Number.isFinite(markReturn);
    return !hasBreak ? 'fused' : hasReturn ? 'done' : 'broken';
  };
  const paint = () => {
    const z = curZ();
    live.textContent = Number.isFinite(z) ? `${t.dist}: ${cm(z).toFixed(0)} см` : t.noFaceShort;
    const ph = phase();
    const bc = camBrk ? cm((camBrk as DetEvent).z) : Number.isFinite(markBreak) ? cm(markBreak) : NaN;
    const rc = camRet ? cm((camRet as DetEvent).z) : Number.isFinite(markReturn) ? cm(markReturn) : NaN;
    if (ph === 'fused') {
      status.textContent = t.trStateWait;
      status.className = 'status';
      btn.replaceChildren(t.trMark, h('small', null, t.trTapHint));
      btn.className = 'markpad';
    } else if (ph === 'broken') {
      status.textContent = `${t.trStateBroken}: ${fmt(bc)}${camBrk ? ` (${t.trSrcCam})` : ` (${t.trSrcMark})`}. ${t.trStateReturnHint}`;
      status.className = 'status brk';
      btn.replaceChildren(t.trMarkReturn, h('small', null, t.trTapHint));
      btn.className = 'markpad pressed';
    } else {
      status.textContent = `${t.trStateBroken}: ${fmt(bc)} → ${t.trStateReturned}: ${fmt(rc)}`;
      status.className = 'status ok';
      btn.replaceChildren(t.trMarkDone);
      btn.className = 'markpad done';
    }
  };
  const stopTap = onTap(() => {
    if (!recording) return;
    const z = Number.isFinite(app.lastInfo?.zq ?? NaN) ? (app.lastInfo as { zq: number }).zq : curZ();
    const ph = phase();
    if (ph === 'fused') {
      markBreak = z;
      if (!breakWall) breakWall = performance.now();
      app.pendingEvent = 'mark_break';
    } else if (ph === 'broken') {
      markReturn = z;
      app.pendingEvent = 'mark_return';
    }
    paint();
  });
  endBtn.addEventListener('click', () => (ended = true));
  const timer = setInterval(paint, 200);
  sheet.set(title, p(app.direction === 'away' ? t.trWaitAway : t.trWaitCloser, 'big'), live, status, btn, h('div', { class: 'btnrow' }, endBtn));
  paint();
  env.recorder.scene = scene;
  const r = await captureUntil({
    prep: 3,
    maxSec: MAX_ATTEMPT_SEC,
    cancel,
    isDone: () => ended || phase() === 'done' || (breakWall > 0 && performance.now() - breakWall > RETURN_WAIT_MS),
    onStart: () => (recording = true),
    onEnd: () => (env.recorder.scene = null),
  });
  clearInterval(timer);
  stop();
  stopTap();
  if (r === 'cancel') return 'cancel';
  const b = camBrk as DetEvent | null;
  const q = camRet as DetEvent | null;
  const camBreakCm = b ? cm(b.z) : NaN;
  const camReturnCm = q ? cm(q.z) : NaN;
  const markBreakCm = cm(markBreak);
  const markReturnCm = cm(markReturn);
  const breakCm = Number.isFinite(camBreakCm) ? camBreakCm : markBreakCm;
  const returnCm = Number.isFinite(camReturnCm) ? camReturnCm : markReturnCm;
  return {
    broke: Number.isFinite(breakCm),
    breakCm,
    returnCm,
    camBreakCm,
    camReturnCm,
    markBreakCm,
    markReturnCm,
    angle: b ? b.value : NaN,
    maxCm: cm(maxZ),
    boundaryCm: Number.isFinite(breakCm) ? (Number.isFinite(returnCm) ? (breakCm + returnCm) / 2 : breakCm) : NaN,
  };
}

interface Stats {
  breakCm: number;
  returnCm: number;
  boundaryCm: number;
  n: number; // попыток со срывом
  total: number;
}
const stats = (a: Attempt[]): Stats => ({
  breakCm: med(a.map((x) => x.breakCm)),
  returnCm: med(a.map((x) => x.returnCm)),
  boundaryCm: med(a.map((x) => x.boundaryCm)),
  n: a.filter((x) => x.broke).length,
  total: a.length,
});

/** Серия попыток. Возвращает попытки или null при отмене. */
async function series(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>, prefix: string, name: string, n: number): Promise<Attempt[] | null> {
  const out: Attempt[] = [];
  const how = app.direction === 'away' ? t.trHowAway : t.trHowCloser;
  for (let k = 1; k <= n; k++) {
    const ttl = `${name} · ${k}/${n}`;
    const a = await screen(ttl, [p(how), p(t.trStopRule, 'why')], [{ key: 'go', label: t.start2, primary: true }, ...(k > 1 ? [{ key: 'end', label: t.trEnd }] : [])]);
    if (a === 'cancel') return null;
    if (a === 'end') break;
    const r = await runAttempt(env, cancel, `${prefix}_${k}`, ttl);
    if (r === 'cancel') return null;
    out.push(r);
    const nodes: Node[] = [];
    if (r.broke) {
      nodes.push(h('p', { class: 'big' }, `${t.trBreakAt}: ${fmt(r.breakCm)} (${Number.isFinite(r.angle) ? sg(r.angle) + '°' : t.trSrcMark})`));
      nodes.push(p(Number.isFinite(r.returnCm) ? `${t.trReturnAt}: ${fmt(r.returnCm)}. ${t.trBoundary}: ${fmt(Math.min(r.breakCm, r.returnCm))}–${fmt(Math.max(r.breakCm, r.returnCm))}.` : t.trNoReturn));
      if (Number.isFinite(r.camBreakCm) && Number.isFinite(r.markBreakCm) && Math.abs(r.camBreakCm - r.markBreakCm) > 5) nodes.push(p(`${t.trSrcDiff}: камера ${fmt(r.camBreakCm)}, ваша отметка ${fmt(r.markBreakCm)}.`, 'why'));
    } else nodes.push(h('p', { class: 'big' }, `${t.trNoBreak} ${r.maxCm.toFixed(0)} см`));
    const dists = out.map((x) => (x.broke ? x.breakCm : NaN));
    if (worsened(dists, app.direction)) nodes.push(p(t.trDropped, 'warn'));
    const c = await screen(ttl, nodes, worsened(dists, app.direction)
      ? [{ key: 'end', label: t.trFinish, primary: true }, { key: 'next', label: t.trContinue }]
      : [{ key: 'next', label: k < n ? t.next : t.trDone, primary: true }]);
    if (c === 'cancel') return null;
    if (c === 'end') break;
  }
  return out;
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

function save(kind: HistRec['kind'], a: Attempt[]): Stats {
  const st = stats(a);
  if (st.total > 0) addHistory({ at: Date.now(), kind, direction: app.direction, breakCm: st.breakCm, returnCm: st.returnCm, boundaryCm: st.boundaryCm, n: st.n });
  return st;
}

function summary(name: string, st: Stats): Node[] {
  if (!Number.isFinite(st.breakCm)) return [h('p', { class: 'big' }, `${name}: ${t.trNoBreakShort}`)];
  const nodes: Node[] = [h('p', { class: 'big' }, `${name}: ${t.trBreakShort} ${fmt(st.breakCm)}${Number.isFinite(st.returnCm) ? `, ${t.trReturnShort} ${fmt(st.returnCm)}` : ''} (${st.n} из ${st.total})`)];
  if (Number.isFinite(st.returnCm)) nodes.push(p(`${t.trBoundary}: ${fmt(Math.min(st.breakCm, st.returnCm))}–${fmt(Math.max(st.breakCm, st.returnCm))}, ${t.trBoundaryMid} ${fmt(st.boundaryCm)}.`));
  return nodes;
}

/** Сравнение с прошлым разом: граница дальше (при отдалении) значит лучше. */
function compare(st: Stats, prev: HistRec | undefined): Node[] {
  if (!prev || !Number.isFinite(st.boundaryCm)) return [];
  const d = st.boundaryCm - prev.boundaryCm;
  const better = app.direction === 'away' ? d > 0 : d < 0;
  const word = Math.abs(d) < 1 ? t.trSame : better ? t.trBetter : t.trWorse;
  return [p(`${t.trPrev}: ${fmt(prev.boundaryCm)} (${fmtDate(prev.at)}) → ${fmt(st.boundaryCm)}: ${word} (${sg(d, 0)} см).`)];
}

/** Быстрый замер: 3 попытки. */
export async function runMeasure(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  }, { full: true });
  const screen = makeScreen(cancel);
  if (!(await preflight(env, cancel, screen))) return sheet.close();
  const prev = lastHistory(['measure', 'before', 'after'], app.direction);
  const d = await series(env, cancel, screen, 'measure', t.trMeasureName, 3);
  if (!d) return;
  const st = save('measure', d);
  for (;;) {
    const a = await screen(t.trMeasureName, [...summary(t.trResult, st), ...compare(st, prev), p(t.trTrend)], [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (a === 'csv') env.recorder.download('measure');
    else break;
  }
  sheet.close();
}

/** Сессия: замер «до» (3 цикла) → удержание на границе (3 мин) → замер «после» (3 цикла) → итог. */
export async function runTraining(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  }, { full: true });
  const screen = makeScreen(cancel);
  if (!(await preflight(env, cancel, screen))) return sheet.close();

  const prev = lastHistory(['after', 'measure'], app.direction);
  const before = await series(env, cancel, screen, 'before', t.trBefore, 3);
  if (!before) return;
  const sb = save('before', before);

  let exNodes: Node[] = [];
  if (!Number.isFinite(sb.breakCm)) {
    const r = await screen(t.hxName, [p(t.hxNoBreak, 'warn')], [{ key: 'next', label: t.next, primary: true }]);
    if (r === 'cancel') return;
  } else {
    const init: HoldInit = { breakCm: sb.breakCm, returnCm: sb.returnCm, source: t.hxFromMeasure };
    const o = await runHold(env, cancel, screen, init, true);
    if (o === 'cancel') return;
    if (o !== 'skip') {
      exNodes = holdSummary(o);
      for (;;) {
        const r = await screen(t.hxName, exNodes, [{ key: 'next', label: t.next, primary: true }, { key: 'csv', label: t.menuCsv }]);
        if (r === 'cancel') return;
        if (r === 'csv') env.recorder.download('hold');
        else break;
      }
    }
  }
  const after = await series(env, cancel, screen, 'after', t.trAfter, 3);
  if (!after) return;
  const sa = save('after', after);

  const nodes: Node[] = [...summary(t.trBefore, sb), ...(exNodes.length ? [h('p', { class: 'big' }, t.hxName), ...exNodes.slice(0, 2)] : []), ...summary(t.trAfter, sa)];
  if (Number.isFinite(sb.boundaryCm) && Number.isFinite(sa.boundaryCm)) {
    const d = sa.boundaryCm - sb.boundaryCm;
    nodes.push(h('p', { class: 'big' }, `${t.trChange}: ${sg(d, 0)} см (${sg((d / sb.boundaryCm) * 100, 0)} %)`));
  }
  nodes.push(...compare(sb, prev));
  nodes.push(p(t.trTrend));
  for (;;) {
    const a = await screen(t.trSessionDone, nodes, [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (a === 'csv') env.recorder.download('session');
    else break;
  }
  sheet.close();
}

/** Удержание на границе отдельно: цель по последнему замеру границы. */
export async function runHoldMenu(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  }, { full: true });
  const screen = makeScreen(cancel);
  const last = lastHistory(['measure', 'before', 'after'], app.direction);
  if (!last || !Number.isFinite(last.breakCm)) {
    await screen(t.hxName, [p(t.hxNeedMeasure, 'warn')], [{ key: 'close', label: t.close, primary: true }]);
    return sheet.close();
  }
  if (!(await preflight(env, cancel, screen))) return sheet.close();
  const init: HoldInit = { breakCm: last.breakCm, returnCm: last.returnCm, source: `${t.hxFromHistory} ${fmtDate(last.at)}` };
  const o = await runHold(env, cancel, screen, init, false);
  if (o === 'cancel' || o === 'skip') return sheet.close();
  for (;;) {
    const r = await screen(t.hxName, holdSummary(o), [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (r === 'csv') env.recorder.download('hold');
    else break;
  }
  sheet.close();
}
