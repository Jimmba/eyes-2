// M3: ядро цикла. Замер «срыв при отдалении» (3 попытки), упражнение 1 (5 попыток), сессия: замер «до» → упражнение → замер «после».
import { Env, runCalibration } from './calibration';
import type { DetEvent } from './core/breakDetector';
import { WIN_DEFAULTS, WindowDetector } from './core/windowDetector';
import { median } from './core/filters';
import { t } from './i18n';
import { FrameInfo, addHistory, app, lastHistory, persist, zeroValid } from './state';
import type { HistRec } from './profile';
import { Cancel, captureUntil, h, onHold, setBorder, sheet } from './ui';
import { HoldInit, holdSummary, runHold } from './exercise';
import { fmtDate, makeScreen, p, sg } from './wizard';
import { ZERO_FRESH_H, runZeroStep, zeroAgeH } from './zero';

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
  markBreakRawCm: number; // дистанция в момент нажатия, без поправки
  markReturnCm: number;
  lagSec: number; // на сколько секунд ваше нажатие позже срыва по камере
  holds: number; // сколько раз вы нажимали (держали касание)
  holdSec: number; // сколько держали в первый раз
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

const HOLD_GRACE_MS = 2500; // после отпускания ждём ещё: вдруг срыв вернулся

async function runAttempt(env: Env, cancel: Cancel, scene: string, title: string): Promise<Attempt | 'cancel'> {
  const det = new WindowDetector(WIN_DEFAULTS); // окно ~1 с против базы попытки; ноль для порога не нужен
  let camBrk: DetEvent | null = null;
  let camBrkWall = 0; // когда камера подтвердила срыв (мс performance.now), для сравнения с нажатием
  let camRet: DetEvent | null = null;
  // Ваша отметка: касание экрана (или пробел) держится, пока есть срыв. Нажатие = срыв, отпускание = возврат.
  interface Seg {
    z0: number; // мм в момент нажатия
    z1: number; // мм в момент отпускания
    t0: number;
    t1: number;
  }
  const segs: Seg[] = [];
  let pressed = false;
  let lastRelease = 0;
  let breakWall = 0;
  let ended = false;
  let recording = false; // касания и события камеры до старта записи (обратный отсчёт) не считаются
  let maxZ = 0;
  const curZ = () => (app.lastInfo && Number.isFinite(app.lastInfo.zs) ? app.lastInfo.zs : NaN);
  const fastZ = () => (app.lastInfo && Number.isFinite(app.lastInfo.zq) ? app.lastInfo.zq : curZ());
  const stop = collect((i) => {
    if (!recording) return;
    const now = performance.now();
    if (Number.isFinite(i.zs)) {
      maxZ = Math.max(maxZ, i.zs);
    }
    const open = Math.min(i.openR, i.openL);
    const e = det.push({ t: now, value: i.devInst, valid: i.face && i.valid && open > 0.25 && Number.isFinite(i.devInst), z: i.zs });
    app.annot.det = det.state === 'broken' ? 1 : 0; // для журнала: что думает камера
    if (!e) return;
    if (e.type === 'break' && !camBrk) {
      camBrk = e;
      camBrkWall = now;
      if (!breakWall) breakWall = now;
      app.pendingEvent = 'break';
    } else if (e.type === 'return' && camBrk && !camRet) {
      camRet = e;
      app.pendingEvent = 'return';
    }
  });

  // --- экран попытки: живое расстояние, состояние и площадка касания ---
  const live = h('p', { class: 'big' }, '…');
  const status = h('p', { class: 'status' }, t.trStateWait);
  const pad = h('div', { class: 'markpad' }, t.trMark, h('small', null, t.trTapHint));
  const endBtn = h('button', {}, t.trEndAttempt);
  const closeSeg = () => {
    const sg0 = segs[segs.length - 1];
    if (!pressed || !sg0) return;
    pressed = false;
    sg0.z1 = fastZ();
    sg0.t1 = performance.now();
    lastRelease = sg0.t1;
    det.forceFused(sg0.t1);
    app.annot.user = 0;
    app.pendingEvent = 'hold_end';
  };
  let finished = false;
  const paint = () => {
    if (recording && !finished) setBorder(pressed || det.state === 'broken' ? 'red' : 'green'); // есть срыв: красная, нет срыва: зелёная
    const z = curZ();
    live.textContent = Number.isFinite(z) ? `${t.dist}: ${cm(z).toFixed(0)} см` : t.noFaceShort;
    const first = segs[0];
    const bc = camBrk ? cm((camBrk as DetEvent).z) : first ? cm(first.z0) : NaN;
    if (pressed) {
      status.textContent = `${t.trStateBroken}: ${fmt(bc)}. ${t.trHoldNow}`;
      status.className = 'status brk';
      pad.replaceChildren(t.trHolding, h('small', null, t.trReleaseHint));
      pad.className = 'markpad pressed';
    } else if (first && Number.isFinite(first.z1)) {
      status.textContent = `${t.trStateBroken}: ${fmt(cm(first.z0))} → ${t.trStateReturned}: ${fmt(cm(first.z1))}${segs.length > 1 ? ` (${t.trHoldsMore} ${segs.length - 1})` : ''}`;
      status.className = 'status ok';
      pad.replaceChildren(t.trMarkDone, h('small', null, t.trAgainHint));
      pad.className = 'markpad done';
    } else {
      status.textContent = camBrk ? `${t.trCamSees}: ${fmt(bc)}. ${t.trCamSeesHint}` : t.trStateWait;
      status.className = camBrk ? 'status brk' : 'status';
      pad.replaceChildren(t.trMark, h('small', null, t.trTapHint));
      pad.className = 'markpad';
    }
  };
  const stopHold = onHold(
    () => {
      if (!recording || pressed) return;
      pressed = true;
      segs.push({ z0: fastZ(), z1: NaN, t0: performance.now(), t1: NaN });
      if (camBrk === null) det.forceBroken();
      app.annot.user = 1;
      if (!breakWall) breakWall = performance.now();
      app.pendingEvent = 'hold_start';
      paint();
    },
    () => {
      closeSeg();
      paint();
    },
  );
  endBtn.addEventListener('click', () => (ended = true));
  const timer = setInterval(paint, 150);
  sheet.set(title, p(app.direction === 'away' ? t.trWaitAway : t.trWaitCloser, 'big'), live, status, pad, h('div', { class: 'btnrow' }, endBtn));
  paint();
  env.recorder.scene = scene;
  const r = await captureUntil({
    prep: 3,
    maxSec: MAX_ATTEMPT_SEC,
    cancel,
    isDone: () => {
      if (ended || pressed) return ended;
      const now = performance.now();
      if (segs.length > 0) return now - lastRelease > HOLD_GRACE_MS; // вы отпустили и 2,5 с ничего не менялось
      return (!!camBrk && !!camRet) || (breakWall > 0 && now - breakWall > RETURN_WAIT_MS);
    },
    onStart: () => (recording = true),
    onEnd: () => (env.recorder.scene = null),
  });
  finished = true;
  clearInterval(timer);
  stop();
  closeSeg(); // вдруг попытку закончили, пока касание ещё держалось
  stopHold();
  app.annot.user = 0;
  app.annot.det = 0;
  if (r === 'cancel') return 'cancel';
  const b = camBrk as DetEvent | null;
  const q = camRet as DetEvent | null;
  const first = segs[0];
  const camBreakCm = b ? cm(b.z) : NaN;
  const camReturnCm = q ? cm(q.z) : NaN;
  const markBreakRawCm = first ? cm(first.z0) : NaN;
  const markReturnCm = first ? cm(first.z1) : NaN;
  // Постоянной задержки человека нет: журнал 24.11 дал нажатие позже камеры на 1,3-1,9 с, журнал 25.11 от −2 до +0,4 с
  // (человек замечает двоение раньше, чем отклонение набирает 5°). Поэтому поправки нет: границей считается ваше нажатие
  // (это то, что вы видите), камера идёт рядом для сверки. Если вы не нажимали, берётся камера.
  const markBreakCm = markBreakRawCm;
  const lagSec = first && b ? (first.t0 - b.onsetT) / 1000 : NaN; // > 0: вы нажали позже камеры
  const breakCm = Number.isFinite(markBreakRawCm) ? markBreakRawCm : camBreakCm;
  const returnCm = Number.isFinite(markReturnCm) ? markReturnCm : camReturnCm;
  return {
    broke: Number.isFinite(breakCm),
    breakCm,
    returnCm,
    camBreakCm,
    camReturnCm,
    markBreakCm,
    markBreakRawCm,
    markReturnCm,
    lagSec,
    holds: segs.length,
    holdSec: first && Number.isFinite(first.t1) ? (first.t1 - first.t0) / 1000 : NaN,
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

/**
 * Серия попыток. Инструкция показывается один раз, перед первой попыткой серии (intro = 'how'), либо вместо неё короткий
 * экран отдыха (intro = 'rest', например перед замером «после» упражнения). После каждой попытки: результат, «Отдохните» и
 * кнопка «Продолжить», которая сразу запускает следующую попытку (обратный отсчёт 3 с). Возвращает попытки или null при отмене.
 */
async function series(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>, prefix: string, name: string, n: number, intro: 'how' | 'rest' = 'how'): Promise<Attempt[] | null> {
  const out: Attempt[] = [];
  const how = app.direction === 'away' ? t.trHowAway : t.trHowCloser;
  const first = await screen(
    `${name} · 1/${n}`,
    intro === 'how' ? [p(how), p(t.trStopRule, 'why')] : [h('p', { class: 'big' }, t.trRest), p(t.trRestBefore, 'why')],
    [{ key: 'go', label: intro === 'how' ? t.start2 : t.trContinue, primary: true }],
  );
  if (first === 'cancel') return null;
  for (let k = 1; k <= n; k++) {
    const ttl = `${name} · ${k}/${n}`;
    const r = await runAttempt(env, cancel, `${prefix}_${k}`, ttl);
    if (r === 'cancel') return null;
    out.push(r);
    const nodes: Node[] = [];
    if (r.broke) {
      nodes.push(h('p', { class: 'big' }, `${t.trBreakAt}: ${fmt(r.breakCm)}${Number.isFinite(r.angle) ? ` (${sg(r.angle)}°)` : ''}`));
      nodes.push(p(Number.isFinite(r.returnCm) ? `${t.trReturnAt}: ${fmt(r.returnCm)}. ${t.trBoundary}: ${fmt(Math.min(r.breakCm, r.returnCm))}–${fmt(Math.max(r.breakCm, r.returnCm))}.` : t.trNoReturn));
      if (Number.isFinite(r.markBreakRawCm) && !Number.isFinite(r.camBreakCm)) nodes.push(p(t.trCamMissed, 'warn'));
      else if (!Number.isFinite(r.markBreakRawCm)) nodes.push(p(t.trYouNoMark, 'why'));
      else nodes.push(p(`${t.trCamVsYou}: камера ${fmt(r.camBreakCm)}, вы нажали на ${fmt(r.markBreakRawCm)}${Number.isFinite(r.lagSec) ? `; ${r.lagSec >= 0 ? 'вы позже камеры на' : 'вы раньше камеры на'} ${Math.abs(r.lagSec).toFixed(1)} с` : ''}.`, 'why'));
      if (r.holds > 0 && Number.isFinite(r.holdSec)) nodes.push(p(`${t.trHeld}: ${r.holdSec.toFixed(1)} с${r.holds > 1 ? `, нажатий ${r.holds}` : ''}.`, 'why'));
    } else nodes.push(h('p', { class: 'big' }, `${t.trNoBreak} ${r.maxCm.toFixed(0)} см`));
    const dists = out.map((x) => (x.broke ? x.breakCm : NaN));
    const dropped = worsened(dists, app.direction);
    if (dropped) nodes.push(p(t.trDropped, 'warn'));
    const last = k === n;
    if (!last) nodes.push(h('p', { class: 'big' }, t.trRest), p(t.trRestHint, 'why'));
    const buttons = last
      ? [{ key: 'next', label: t.trDone, primary: true }]
      : dropped
        ? [{ key: 'end', label: t.trFinish, primary: true }, { key: 'next', label: t.trContinue }]
        : [{ key: 'next', label: t.trContinue, primary: true }, { key: 'end', label: t.trEnd }];
    const c = await screen(`${ttl}`, nodes, buttons);
    if (c === 'cancel') return null;
    if (c === 'end') break;
  }
  return out;
}

/** Нужен ли ноль: нет совсем (обязательно) или устарел (предлагаем). Кнопка ведёт к нулю и возвращает на этот же экран. */
async function ensureZero(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>): Promise<boolean> {
  for (;;) {
    const valid = zeroValid() && !!app.zero;
    const age = valid ? zeroAgeH() : Infinity;
    if (valid && age <= ZERO_FRESH_H) return true;
    const a = await screen(
      t.zeroName,
      [p(valid ? t.zeroStale(age) : t.zeroMissing, 'warn')],
      [{ key: 'zero', label: t.zeroDo, primary: true }, ...(valid ? [{ key: 'keep', label: t.zeroKeep }] : []), { key: 'close', label: t.close }],
    );
    if (a === 'cancel' || a === 'close') return false;
    if (a === 'keep') return true;
    if (!(await runZeroStep({ env, cancel, screen }, t.zeroName, { force: true }))) return false;
  }
}

async function preflight(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>): Promise<boolean> {
  if (!(await env.ensureCamera())) {
    sheet.set(t.menuTrain, p(t.needCamera));
    return false;
  }
  if (!app.model) {
    const a = await screen(t.menuTrain, [p(t.trNeedCalib, 'warn')], [{ key: 'calib', label: t.trOpenCalib, primary: true }, { key: 'close', label: t.close }]);
    if (a === 'calib') {
      sheet.close();
      await runCalibration(env); // после калибровки пользователь сам запускает замер из меню
    }
    return false;
  }
  if (!(await ensureZero(env, cancel, screen))) return false;
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
  }, { full: true, section: t.menuMeasure });
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
  }, { full: true, section: t.menuTrain });
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
  const after = await series(env, cancel, screen, 'after', t.trAfter, 3, 'rest');
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
  }, { full: true, section: t.menuHold });
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
