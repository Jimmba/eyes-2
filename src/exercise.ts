// Упражнение «Удержание на границе»: приложение командует, пользователь держит расстояние на краю контроля.
// Экран во всю страницу: мишень у верхнего края (рядом с камерой), крупная команда, шкала расстояния.
// Срыв и возврат находит камера; если не заметила, касание экрана в любом месте или пробел.
import type { Env } from './calibration';
import { WIN_DEFAULTS, WindowDetector } from './core/windowDetector';
import { median } from './core/filters';
import { letterHeightMm } from './core/scale';
import { HOLD_DEFAULTS, HoldController, HoldStop, TARGET_CODE, TARGET_DEG, TargetSize, dynamicStage } from './core/hold';
import { t } from './i18n';
import type { HistRec } from './profile';
import { addHistory, app, lastHistory, persist, screenValid } from './state';
import { Cancel, h, onHold, setBorder, sheet, wait } from './ui';
import { fmtDate, makeScreen, p, sg } from './wizard';

export interface HoldInit {
  breakCm: number;
  returnCm: number;
  source?: string; // откуда граница: «замер перед упражнением» или «замер от даты»
}
export interface HoldOutcome {
  breaks: number;
  ups: number;
  downs: number;
  bestHoldCm: number;
  longestHoldSec: number;
  fusedSec: number;
  durSec: number;
  H0: number;
  Hfinal: number;
  breakCm: number;
  returnCm: number;
  stop: HoldStop;
  size: 'small' | 'medium' | 'large' | 'dynamic';
  stageBreaks: number[]; // срывы по третям времени (при динамичной: крупная, средняя, мелкая)
}

/** Мишень: мордочка кота с мелкими деталями (усы, радужки) и яркими глазами, на них и смотреть. Вектор: размер задаётся в пикселях. */
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="14,40 18,8 42,24" fill="#f4a64a"/><polygon points="86,40 82,8 58,24" fill="#f4a64a"/><polygon points="20,34 22,16 35,25" fill="#f7c9a0"/><polygon points="80,34 78,16 65,25" fill="#f7c9a0"/><ellipse cx="50" cy="56" rx="38" ry="34" fill="#f4a64a"/><path d="M50 24L50 34M42 25L43 33M58 25L57 33" stroke="#b86a1c" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="50" cy="68" rx="14" ry="10" fill="#fbe3c6"/><circle cx="34" cy="50" r="9" fill="#fff"/><circle cx="66" cy="50" r="9" fill="#fff"/><circle cx="34" cy="50" r="5.5" fill="#3aa86b"/><circle cx="66" cy="50" r="5.5" fill="#3aa86b"/><circle cx="34" cy="50" r="2.6" fill="#111"/><circle cx="66" cy="50" r="2.6" fill="#111"/><circle cx="35.6" cy="48.4" r="1.1" fill="#fff"/><circle cx="67.6" cy="48.4" r="1.1" fill="#fff"/><polygon points="46,62 54,62 50,67" fill="#e0707a"/><path d="M50 67L50 71M50 71Q44 76 39 72M50 71Q56 76 61 72" stroke="#7a3b2e" stroke-width="1.3" fill="none" stroke-linecap="round"/><g stroke="#fff" stroke-width="1" stroke-linecap="round"><path d="M36 66L10 60"/><path d="M36 69L9 70"/><path d="M36 72L11 80"/><path d="M64 66L90 60"/><path d="M64 69L91 70"/><path d="M64 72L89 80"/></g></svg>`;
const SIZE_LABEL: Record<TargetSize, string> = { small: 'мелкая', medium: 'средняя', large: 'крупная' };

/** Размер CSS-пикселя в мм: по калибровке экрана, иначе грубая оценка (телефон ~0,16 мм, монитор ~0,26 мм). */
export function mmPerCssPx(): { mm: number; calibrated: boolean } {
  if (screenValid() && app.screen) return { mm: app.screen.mmPerCssPx, calibrated: true };
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return { mm: touch && window.devicePixelRatio >= 2 ? 0.16 : 0.26, calibrated: false };
}

const fmtCm = (x: number) => (Number.isFinite(x) ? `${x.toFixed(0)} см` : '—');
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.floor(sec % 60))).padStart(2, '0')}`;

function cmdText(key: string, dir: 1 | -1, H: number): string {
  switch (key) {
    case 'enter':
      return t.hxEnter;
    case 'hold':
      return t.hxHold;
    case 'closer':
      return t.hxCloser;
    case 'farther':
      return t.hxFarther;
    case 'recover':
      return dir > 0 ? t.hxRecoverAway : t.hxRecoverCloser;
    case 'up':
      return `${t.hxUp}${dir > 0 ? t.hxFarther : t.hxCloser}: ${H.toFixed(0)} см`;
    case 'down':
      return `${t.hxDown}${dir > 0 ? t.hxCloser : t.hxFarther}: ${H.toFixed(0)} см`;
    case 'face':
      return t.hxFace;
    default:
      return t.hxDoneCmd;
  }
}

/** Экран выбора мишени и пояснения. Возвращает ключ кнопки. */
async function intro(screen: ReturnType<typeof makeScreen>, init: HoldInit, dir: 1 | -1, canSkip: boolean): Promise<string> {
  const probe = new HoldController({ dir, breakCm: init.breakCm, returnCm: init.returnCm, ...HOLD_DEFAULTS });
  const sizes = h('div', { class: 'sizes' });
  const names: Record<ExPrefsSize, string> = { small: t.hxSizeSmall, medium: t.hxSizeMed, large: t.hxSizeLarge, dynamic: t.hxSizeDyn };
  const paint = () => {
    sizes.replaceChildren(
      ...(['small', 'medium', 'large', 'dynamic'] as const).map((k) =>
        h('button', { class: app.ex.size === k ? 'sel' : '', onclick: () => { app.ex.size = k; persist(); paint(); } }, names[k]),
      ),
    );
  };
  paint();
  const cal = mmPerCssPx();
  const nodes: Node[] = [
    p(t.hxHow),
    p(`${t.hxBoundary}: ${t.trBreakShort} ${fmtCm(init.breakCm)}${Number.isFinite(init.returnCm) ? `, ${t.trReturnShort} ${fmtCm(init.returnCm)}` : ''}${init.source ? ` (${init.source})` : ''}. ${t.hxStartAt}: ${fmtCm(probe.H0)}.`, 'big'),
    p(t.hxTarget, 'why'),
    sizes,
    p(t.hxSizeNote, 'why'),
  ];
  if (!cal.calibrated) nodes.push(p(t.hxSizeApprox, 'why'));
  nodes.push(p(t.hxTapNote, 'why'));
  return screen(t.hxName, nodes, [{ key: 'go', label: t.start2, primary: true }, ...(canSkip ? [{ key: 'skip', label: t.hxSkip }] : [])]);
}
type ExPrefsSize = 'small' | 'medium' | 'large' | 'dynamic';

export async function runHold(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>, init: HoldInit, canSkip: boolean): Promise<HoldOutcome | 'cancel' | 'skip'> {
  const dir: 1 | -1 = app.direction === 'away' ? 1 : -1;
  const a = await intro(screen, init, dir, canSkip);
  if (a === 'cancel') return 'cancel';
  if (a === 'skip') return 'skip';

  const ctrl = new HoldController({ dir, breakCm: init.breakCm, returnCm: init.returnCm, ...HOLD_DEFAULTS });
  const det = new WindowDetector(WIN_DEFAULTS); // окно ~1 с против собственной базы (ноль для порога не нужен)
  const pref = app.ex.size;
  const third = HOLD_DEFAULTS.totalSec / 3;

  // ---- разметка экрана ----
  const target = h('div', { class: 'exTarget' });
  const face = h('span', { class: 'exFace' });
  const cmd = h('div', { class: 'exCmd idle' }, '…');
  const sub = h('div', { class: 'exSub' }, '');
  const mark = h('div', { class: 'mark' });
  const gauge = h('div', { class: 'gauge' }, h('div', { class: 'band' }), mark);
  const lbl = h('div', { class: 'gaugeLbl' }, h('span', null, t.hxNear), h('span', null, t.hxFar));
  const stat = h('div', { class: 'exStat' }, '');
  const hint = h('div', { class: 'exHint' }, t.hxHint);
  const endBtn = h('button', { onclick: () => ctrl.finish('user') }, t.hxEnd);
  sheet.head(false);
  sheet.set('', h('div', { class: 'ex' }, face, target, cmd, sub, gauge, lbl, stat, hint, endBtn));

  // Размер: фиксированный на всё упражнение (мелкая, средняя, крупная) или по третям времени (динамичная). Физический размер
  // считается один раз на стартовую дистанцию и не меняется, пока не сменится треть.
  let curSize: TargetSize | null = null;
  const sizeNow = (): TargetSize => (pref === 'dynamic' ? dynamicStage(ctrl.elapsedSec, HOLD_DEFAULTS.totalSec) : pref);
  const applySize = (sz: TargetSize) => {
    if (sz === curSize) return;
    curSize = sz;
    const mm = mmPerCssPx().mm;
    const hPx = Math.min(Math.max(letterHeightMm(TARGET_DEG[sz] * 60, ctrl.H0 * 10) / mm, 14), 360);
    target.innerHTML = PICTURE;
    const svg = target.firstElementChild as SVGElement;
    svg.setAttribute('width', hPx.toFixed(0));
    svg.setAttribute('height', hPx.toFixed(0));
    target.style.height = `${(hPx + 8).toFixed(0)}px`;
    app.annot.size = TARGET_CODE[sz];
  };
  applySize(sizeNow());

  // ---- кадры камеры: срыв и возврат ----
  let live = false; // касания и события камеры во время обратного отсчёта не считаются
  let holdingUser = false; // пользователь держит касание: он видит срыв
  let lastValid = performance.now();
  const stopSink = (() => {
    const cb = (i: import('./state').FrameInfo) => {
      const now = performance.now();
      const ok = i.face && i.valid && Number.isFinite(i.zq);
      if (ok) lastValid = now;
      if (!live) return;
      const e = det.push({ t: now, value: i.devInst, valid: ok && Math.min(i.openR, i.openL) > 0.25 && Number.isFinite(i.devInst), z: i.zs });
      app.annot.det = det.state === 'broken' ? 1 : 0;
      if (!e) return;
      if (e.type === 'break') {
        if (ctrl.onBreak(e.z / 10, now, 'camera')) app.pendingEvent = 'hold_break';
      } else if (!holdingUser && ctrl.onReturn(e.z / 10, now, 'camera')) app.pendingEvent = 'hold_return'; // пока вы держите касание, камера возврат не объявляет
    };
    app.sinks.add(cb);
    return () => app.sinks.delete(cb);
  })();

  // ---- касание экрана (или пробел) держится, пока есть срыв; отпустили: слилось. Пишется в user_hold ----
  const curCm = () => (app.lastInfo && Number.isFinite(app.lastInfo.zq) ? app.lastInfo.zq / 10 : NaN);
  const stopTap = onHold(
    () => {
      if (!live || holdingUser) return;
      holdingUser = true;
      app.annot.user = 1;
      app.pendingEvent = 'hold_start';
      if (ctrl.phase !== 'recover' && ctrl.phase !== 'done' && ctrl.onBreak(curCm(), performance.now(), 'tap')) det.forceBroken();
    },
    () => {
      if (!holdingUser) return;
      holdingUser = false;
      app.annot.user = 0;
      app.pendingEvent = 'hold_end';
      if (ctrl.phase === 'recover' && ctrl.onReturn(curCm(), performance.now(), 'tap')) det.forceFused(performance.now());
    },
  );

  // ---- обратный отсчёт: цифры в команде ----
  try {
    env.recorder.scene = 'hold';
    for (let s = 3; s > 0; s--) {
      cmd.className = 'exCmd idle';
      cmd.textContent = String(s);
      sub.textContent = `${t.hxTarget2}: ${ctrl.H.toFixed(0)} см`;
      if (await wait(1000, cancel)) return 'cancel';
    }
    live = true;
    setBorder('green'); // идёт упражнение, срыва нет; красная при срыве, после конца исчезает
    ctrl.tick(performance.now(), curCm(), true);

    // ---- основной цикл: команды раз в ~150 мс ----
    while (ctrl.phase !== 'done') {
      const now = performance.now();
      const faceOk = now - lastValid < 1500;
      const z = curCm();
      ctrl.tick(now, z, faceOk);
      const c = ctrl.command(faceOk, z);
      cmd.className = `exCmd ${c.style}`;
      cmd.textContent = cmdText(c.key, dir, ctrl.H);
      sub.textContent = `${t.hxTarget2}: ${ctrl.H.toFixed(0)} см · ${t.hxNow}: ${Number.isFinite(z) ? z.toFixed(0) : '—'} см`;
      mark.style.left = `${(ctrl.gaugePos(z) * 100).toFixed(1)}%`;
      mark.className = `mark${c.style === 'go' ? ' in' : ''}`;
      face.className = `exFace${faceOk ? '' : ' bad'}`;
      setBorder(ctrl.phase === 'recover' ? 'red' : 'green');
      app.annot.phase = ['enter', 'hold', 'recover', 'up', 'down', 'done'].indexOf(ctrl.phase);
      app.annot.target = ctrl.H;
      const sz = sizeNow();
      applySize(sz);
      stat.textContent = `${t.hxHoldStat} ${ctrl.holdSec.toFixed(0)}/${HOLD_DEFAULTS.successSec} с · ${t.hxBreaks} ${ctrl.breaks.length} · ${t.hxSteps} ${ctrl.ups} · ${mmss(HOLD_DEFAULTS.totalSec - ctrl.elapsedSec)}${pref === 'dynamic' ? ` · ${t.hxTargetNow}: ${SIZE_LABEL[sz]}` : ''}`;
      if (await wait(150, cancel)) return 'cancel';
    }
  } finally {
    stopSink();
    stopTap();
    setBorder('off');
    app.annot.det = 0;
    app.annot.user = 0;
    app.annot.phase = 0;
    app.annot.target = 0;
    app.annot.size = 0;
    env.recorder.scene = null;
    sheet.head(true);
  }

  const dur = Math.min(ctrl.elapsedSec, HOLD_DEFAULTS.totalSec);
  const med = (a: { cm: number }[]) => (a.length ? median(a.map((x) => x.cm)) : NaN);
  const stageBreaks = [0, 0, 0]; // для динамичной: срывы на крупной, средней, мелкой
  for (const b of ctrl.breaks) stageBreaks[Math.min(2, Math.floor(b.tSec / third))]++;
  return {
    breaks: ctrl.breaks.length,
    ups: ctrl.ups,
    downs: ctrl.downs,
    bestHoldCm: ctrl.bestHoldCm,
    longestHoldSec: ctrl.longestHoldMs / 1000,
    fusedSec: ctrl.fusedMs / 1000,
    durSec: dur,
    H0: ctrl.H0,
    Hfinal: ctrl.H,
    breakCm: med(ctrl.breaks),
    returnCm: med(ctrl.returns),
    stop: ctrl.stop,
    size: pref,
    stageBreaks,
  };
}

/** Итог упражнения: сохраняет запись и возвращает узлы для экрана. */
export function holdSummary(o: HoldOutcome): Node[] {
  const dir = app.direction;
  const prev = lastHistory(['exercise'], dir);
  const rec: HistRec = {
    at: Date.now(),
    kind: 'exercise',
    direction: dir,
    breakCm: o.breakCm,
    returnCm: o.returnCm,
    boundaryCm: Number.isFinite(o.breakCm) ? (Number.isFinite(o.returnCm) ? (o.breakCm + o.returnCm) / 2 : o.breakCm) : NaN,
    n: o.breaks,
    holdCm: o.bestHoldCm,
    holdSec: o.longestHoldSec,
    breaks: o.breaks,
    durSec: o.durSec,
    size: o.size,
  };
  if (o.durSec > 5) addHistory(rec);
  const nodes: Node[] = [];
  if (Number.isFinite(o.bestHoldCm)) nodes.push(h('p', { class: 'big' }, `${t.hxBest}: ${fmtCm(o.bestHoldCm)} (${t.hxStartAt} ${fmtCm(o.H0)}), ${t.hxLongest} ${o.longestHoldSec.toFixed(0)} с`));
  else nodes.push(h('p', { class: 'big' }, `${t.hxNoStep}: ${t.hxLongest} ${o.longestHoldSec.toFixed(0)} с, ${t.hxStartAt} ${fmtCm(o.H0)}`));
  const perMin = o.durSec > 0 ? (o.breaks / o.durSec) * 60 : 0;
  nodes.push(p(`${t.hxBreaks}: ${o.breaks} (${perMin.toFixed(1)} ${t.hxPerMin}); ${t.hxFused}: ${o.fusedSec.toFixed(0)} ${t.hxOf} ${o.durSec.toFixed(0)} с; ${t.hxSteps}: +${o.ups}${o.downs ? `, −${o.downs}` : ''}.`));
  if (o.size === 'dynamic') nodes.push(p(`${t.hxByStage}: ${t.hxSizeLarge.toLowerCase()} ${o.stageBreaks[0]}, ${t.hxSizeMed.toLowerCase()} ${o.stageBreaks[1]}, ${t.hxSizeSmall.toLowerCase()} ${o.stageBreaks[2]}.`));
  if (o.stop === 'rule') nodes.push(p(t.hxRuleStop, 'warn'));
  if (prev && Number.isFinite(prev.holdCm ?? NaN) && Number.isFinite(o.bestHoldCm)) {
    const d = o.bestHoldCm - (prev.holdCm as number);
    const better = dir === 'away' ? d > 0 : d < 0;
    nodes.push(p(`${t.hxPrev}: ${fmtCm(prev.holdCm as number)} (${fmtDate(prev.at)}) → ${fmtCm(o.bestHoldCm)}: ${Math.abs(d) < 1 ? t.trSame : better ? t.trBetter : t.trWorse} (${sg(d, 0)} см).${prev.size && prev.size !== rec.size ? ' ' + t.hxSizeDiffers : ''}`));
  }
  nodes.push(p(t.hxEvidence, 'why'));
  return nodes;
}
