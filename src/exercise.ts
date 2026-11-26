// Упражнение «Удержание на границе»: приложение командует, пользователь держит расстояние на краю контроля.
// Экран во всю страницу: мишень у верхнего края (рядом с камерой), крупная команда, шкала расстояния.
// Срыв и возврат находит камера; если не заметила, касание экрана в любом месте или пробел.
import type { Env } from './calibration';
import { WIN_DEFAULTS, WindowDetector } from './core/windowDetector';
import { median } from './core/filters';
import { letterHeightMm } from './core/scale';
import { HOLD_DEFAULTS, HoldController, HoldStop } from './core/hold';
import { t } from './i18n';
import type { HistRec } from './profile';
import { addHistory, app, lastHistory, persist, screenValid } from './state';
import { Cancel, h, onTap, setBorder, sheet, wait } from './ui';
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
}

const ARCMIN: Record<'small' | 'medium' | 'large', number> = { small: 7.5, medium: 15, large: 30 }; // высота буквы: 7,5′ примерно 20/30
const LETTERS = 'CDHKNORSVZ';

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
  const paint = () => {
    sizes.replaceChildren(
      ...(['small', 'medium', 'large'] as const).map((k) =>
        h('button', { class: app.ex.size === k ? 'sel' : '', onclick: () => { app.ex.size = k; persist(); paint(); } }, k === 'small' ? t.hxSizeSmall : k === 'medium' ? t.hxSizeMed : t.hxSizeLarge),
      ),
    );
  };
  paint();
  const dyn = h('input', { type: 'checkbox', checked: app.ex.dyn, onchange: (e: Event) => { app.ex.dyn = (e.target as HTMLInputElement).checked; persist(); } });
  const cal = mmPerCssPx();
  const nodes: Node[] = [
    p(t.hxHow),
    p(`${t.hxBoundary}: ${t.trBreakShort} ${fmtCm(init.breakCm)}${Number.isFinite(init.returnCm) ? `, ${t.trReturnShort} ${fmtCm(init.returnCm)}` : ''}${init.source ? ` (${init.source})` : ''}. ${t.hxStartAt}: ${fmtCm(probe.H0)}.`, 'big'),
    p(t.hxTarget, 'why'),
    sizes,
    h('p', null, h('label', null, dyn, t.hxDyn)),
  ];
  if (!cal.calibrated) nodes.push(p(t.hxSizeApprox, 'why'));
  nodes.push(p(t.hxTapNote, 'why'));
  return screen(t.hxName, nodes, [{ key: 'go', label: t.start2, primary: true }, ...(canSkip ? [{ key: 'skip', label: t.hxSkip }] : [])]);
}

export async function runHold(env: Env, cancel: Cancel, screen: ReturnType<typeof makeScreen>, init: HoldInit, canSkip: boolean): Promise<HoldOutcome | 'cancel' | 'skip'> {
  const dir: 1 | -1 = app.direction === 'away' ? 1 : -1;
  const a = await intro(screen, init, dir, canSkip);
  if (a === 'cancel') return 'cancel';
  if (a === 'skip') return 'skip';

  const ctrl = new HoldController({ dir, breakCm: init.breakCm, returnCm: init.returnCm, ...HOLD_DEFAULTS });
  const det = new WindowDetector(WIN_DEFAULTS); // окно ~1 с против собственной базы (ноль для порога не нужен)

  // ---- разметка экрана ----
  const target = h('div', { class: 'exTarget' });
  const letter = h('span', null, 'K');
  target.append(letter);
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

  const size = (): { fontPx: number; boxPx: number } => {
    const mm = mmPerCssPx().mm;
    const distMm = app.ex.dyn && app.lastInfo && Number.isFinite(app.lastInfo.zs) ? app.lastInfo.zs : ctrl.H0 * 10;
    const hPx = letterHeightMm(ARCMIN[app.ex.size], distMm) / mm; // высота прописной буквы
    const fontPx = Math.min(Math.max(hPx / 0.72, 6), 260);
    return { fontPx, boxPx: Math.max(44, fontPx * 1.5) };
  };
  const applySize = () => {
    const s = size();
    letter.style.fontSize = `${s.fontPx.toFixed(1)}px`;
    target.style.height = `${s.boxPx.toFixed(0)}px`;
  };
  applySize();

  // ---- кадры камеры: срыв и возврат ----
  let live = false; // касания и события камеры во время обратного отсчёта не считаются
  let lastValid = performance.now();
  let lastLetter = performance.now();
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
      } else if (ctrl.onReturn(e.z / 10, now, 'camera')) app.pendingEvent = 'hold_return';
    };
    app.sinks.add(cb);
    return () => app.sinks.delete(cb);
  })();

  // ---- касание экрана и пробел: срыв, если слито; возврат, если сорвано ----
  const curCm = () => (app.lastInfo && Number.isFinite(app.lastInfo.zq) ? app.lastInfo.zq / 10 : NaN);
  const stopTap = onTap(() => {
    if (!live) return;
    const now = performance.now();
    if (ctrl.phase === 'recover') {
      if (ctrl.onReturn(curCm(), now, 'tap')) {
        det.forceFused(now);
        app.pendingEvent = 'hold_return_tap';
      }
    } else if (ctrl.phase !== 'done' && ctrl.onBreak(curCm(), now, 'tap')) {
      det.forceBroken(); // чтобы камера увидела возврат
      app.pendingEvent = 'hold_break_tap';
    }
  });

  // ---- обратный отсчёт: цифры в команде ----
  try {
    env.recorder.scene = 'hold';
    for (let s = 3; s > 0; s--) {
      cmd.className = 'exCmd idle';
      cmd.textContent = String(s);
      sub.textContent = `${t.hxTarget2}: ${ctrl.H.toFixed(0)} см`;
      if (await wait(1000, cancel)) return 'cancel';
    }
    setBorder('red');
    live = true;
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
      app.annot.phase = ['enter', 'hold', 'recover', 'up', 'down', 'done'].indexOf(ctrl.phase);
      app.annot.target = ctrl.H;
      stat.textContent = `${t.hxHoldStat} ${ctrl.holdSec.toFixed(0)}/${HOLD_DEFAULTS.successSec} с · ${t.hxBreaks} ${ctrl.breaks.length} · ${t.hxSteps} ${ctrl.ups} · ${mmss(HOLD_DEFAULTS.totalSec - ctrl.elapsedSec)}`;
      if (now - lastLetter > 6000) {
        lastLetter = now;
        let ch = letter.textContent ?? 'K';
        while (ch === letter.textContent) ch = LETTERS[Math.floor(Math.random() * LETTERS.length)];
        letter.textContent = ch;
      }
      if (app.ex.dyn) applySize();
      if (await wait(150, cancel)) {
        setBorder('off');
        return 'cancel';
      }
    }
    setBorder('green');
  } finally {
    stopSink();
    stopTap();
    app.annot.det = 0;
    app.annot.phase = 0;
    app.annot.target = 0;
    env.recorder.scene = null;
    sheet.head(true);
  }

  const dur = Math.min(ctrl.elapsedSec, HOLD_DEFAULTS.totalSec);
  const med = (a: { cm: number }[]) => (a.length ? median(a.map((x) => x.cm)) : NaN);
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
    size: app.ex.size + (app.ex.dyn ? '+dyn' : ''),
  };
  if (o.durSec > 5) addHistory(rec);
  const nodes: Node[] = [];
  if (Number.isFinite(o.bestHoldCm)) nodes.push(h('p', { class: 'big' }, `${t.hxBest}: ${fmtCm(o.bestHoldCm)} (${t.hxStartAt} ${fmtCm(o.H0)}), ${t.hxLongest} ${o.longestHoldSec.toFixed(0)} с`));
  else nodes.push(h('p', { class: 'big' }, `${t.hxNoStep}: ${t.hxLongest} ${o.longestHoldSec.toFixed(0)} с, ${t.hxStartAt} ${fmtCm(o.H0)}`));
  const perMin = o.durSec > 0 ? (o.breaks / o.durSec) * 60 : 0;
  nodes.push(p(`${t.hxBreaks}: ${o.breaks} (${perMin.toFixed(1)} ${t.hxPerMin}); ${t.hxFused}: ${o.fusedSec.toFixed(0)} ${t.hxOf} ${o.durSec.toFixed(0)} с; ${t.hxSteps}: +${o.ups}${o.downs ? `, −${o.downs}` : ''}.`));
  if (o.stop === 'rule') nodes.push(p(t.hxRuleStop, 'warn'));
  if (prev && Number.isFinite(prev.holdCm ?? NaN) && Number.isFinite(o.bestHoldCm)) {
    const d = o.bestHoldCm - (prev.holdCm as number);
    const better = dir === 'away' ? d > 0 : d < 0;
    nodes.push(p(`${t.hxPrev}: ${fmtCm(prev.holdCm as number)} (${fmtDate(prev.at)}) → ${fmtCm(o.bestHoldCm)}: ${Math.abs(d) < 1 ? t.trSame : better ? t.trBetter : t.trWorse} (${sg(d, 0)} см).${prev.size && prev.size !== rec.size ? ' ' + t.hxSizeDiffers : ''}`));
  }
  nodes.push(p(t.hxEvidence, 'why'));
  return nodes;
}
