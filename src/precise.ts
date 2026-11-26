// Шаги мастера калибровки, которые вынесены из calibration.ts:
//  - «Расстояние до камеры»: известное расстояние + размер радужки в кадре → поле зрения камеры (обязательный, один раз на камеру);
//  - «Уточнение углов» (по желанию): размер экрана по карте + сетка 3×3 → коэффициенты глаз.
import type { Env } from './calibration';
import { combineGains, fitGain, type GainFit } from './core/eyeFit';
import { median } from './core/filters';
import { rToEuler } from './core/linalg';
import { focalFromKnownDistance, fovFromFocal, fovVerticalFromDiagonal, isPlausibleFov } from './core/scale';
import { ScreenSpec, mmPerCssPxFromCard, screenToCam, trueGazeDeg } from './core/screenGeom';
import { t } from './i18n';
import { FrameInfo, app, currentFov, fovCalibrated, persist, screenValid, setDistK, setFov, setGains } from './state';
import { stim } from './stim';
import { Cancel, h, setBorder, sheet, timedCapture, wait } from './ui';
import { fmtDate, makeScreen, p, why } from './wizard';

export interface Ctx {
  env: Env;
  cancel: Cancel;
  screen: ReturnType<typeof makeScreen>;
}

const CARD_RATIO = 53.98 / 85.6;
const GRID_FX = [0.1, 0.5, 0.9];
const GRID_FY = [0.12, 0.5, 0.88];
const SETTLE_MS = 800; // пауза на перевод взгляда на новую точку
const DWELL_MS = 1500; // сколько снимаем на точке
const CAM_OFFSET_MM = 4; // центр камеры ниже верхнего края экрана (во весь экран); стартовое значение
const A4_LONG_CM = 29.7;

function collect(cb: (i: FrameInfo) => void): () => void {
  app.sinks.add(cb);
  return () => app.sinks.delete(cb);
}

// =====================================================================================
// Расстояние до камеры. Вы задаёте расстояние, приложение по размеру радужки в кадре вычисляет
// поле зрения камеры. Дальше расстояние считается само: Z = f·D/d для любого положения лица.
// Обязательный шаг: пропуск доступен, только если значение для этой камеры и разрешения уже записано.
// =====================================================================================
const S0size = (): { w: number; h: number } => ({ w: app.lastInfo?.w ?? 0, h: app.lastInfo?.h ?? 0 });

/** Ввод поля зрения вручную: прямо (по вертикали, °) или по диагонали из паспорта камеры. */
async function manualFov(c: Ctx, title: string, size: { w: number; h: number }): Promise<'saved' | 'back' | 'cancel'> {
  const { screen } = c;
  for (;;) {
    const cur = size.w ? currentFov(size.w, size.h) : 63;
    const vert = h('input', { type: 'number', min: '40', max: '100', step: '0.5', value: cur.toFixed(1) });
    const diag = h('input', { type: 'number', min: '50', max: '140', step: '0.5', value: '' });
    const a = await screen(
      title,
      [
        p(t.distManualHow),
        h('p', null, t.distManualVert + ': ', vert, ' °'),
        h('p', null, t.distManualDiag + ': ', diag, ' °'),
        p(t.distManualNote, 'why'),
      ],
      [{ key: 'save', label: t.save, primary: true }, { key: 'back', label: t.back }],
    );
    if (a === 'cancel') return 'cancel';
    if (a === 'back') return 'back';
    let fov = Number(vert.value);
    if (diag.value.trim() && size.w) fov = fovVerticalFromDiagonal(Number(diag.value), size.w, size.h);
    if (!size.w || !isPlausibleFov(fov)) {
      await screen(title, [p(t.distBad + ` (${Number.isFinite(fov) ? fov.toFixed(0) : '?'}°)`, 'warn')], [{ key: 'ok', label: t.back, primary: true }]);
      continue;
    }
    setFov(size.w, size.h, fov);
    setDistK(size.w, size.h, 1);
    c.env.refresh();
    const d = await screen(title, [h('p', { class: 'big' }, `${t.distResult}: ${fov.toFixed(1)}° (${t.distManualDone})`), p(t.distCheckHint)], [{ key: 'next', label: t.next, primary: true }]);
    return d === 'cancel' ? 'cancel' : 'saved';
  }
}

export async function stepDistance(c: Ctx, title: string): Promise<boolean> {
  const { env, cancel, screen } = c;
  const w0 = app.lastInfo?.w ?? 0;
  const h0 = app.lastInfo?.h ?? 0;
  if (w0 && fovCalibrated(w0, h0)) {
    const a = await screen(
      title,
      [why(t.whyLabel, t.distWhy), p(`${t.distSaved}: ${currentFov(w0, h0).toFixed(0)}° (${w0}×${h0}).`, 'big')],
      [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }],
    );
    if (a === 'cancel') return false;
    if (a === 'skip') return true;
  }
  for (;;) {
    const input = h('input', { type: 'number', min: '20', max: '100', step: '0.1', value: String(A4_LONG_CM) });
    const a = await screen(title, [why(t.whyLabel, t.distWhy), p(t.distHow), h('p', null, t.distInput + ': ', input)], [{ key: 'go', label: t.start2, primary: true }, { key: 'manual', label: t.distManual }]);
    if (a === 'cancel') return false;
    if (a === 'manual') {
      const r = await manualFov(c, title, S0size());
      if (r === 'cancel') return false;
      if (r === 'saved') return true;
      continue;
    }
    const zMm = Number(input.value) * 10;
    if (!(zMm >= 200 && zMm <= 1000)) continue;
    sheet.set(title, p(t.distWait, 'big'));
    const S: FrameInfo[] = [];
    const stop = collect((i) => {
      // берём кадры с лицом прямо: поворот головы уменьшает видимый размер радужки
      if (i.face && i.valid && i.Rimg && Math.abs(rToEuler(i.Rimg).yaw) < 8) S.push(i);
    });
    const ok = await timedCapture({ prep: 3, duration: 4, cancel, onStart: () => (env.recorder.scene = 'distance'), onEnd: () => (env.recorder.scene = null) });
    stop();
    if (!ok) return false;
    if (S.length < 8) {
      const r = await screen(title, [p(t.distFew, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
      if (r === 'cancel') return false;
      continue;
    }
    const irisPx = median(S.map((x) => x.irisPx));
    const f = focalFromKnownDistance(irisPx, app.iris.irisMm, zMm);
    const fov = fovFromFocal(S[0].h, f);
    if (!isPlausibleFov(fov)) {
      const r = await screen(title, [p(`${t.distBad} (${fov.toFixed(0)}°)`, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
      if (r === 'cancel') return false;
      continue;
    }
    const prev = currentFov(S[0].w, S[0].h);
    const d = await screen(title, [h('p', { class: 'big' }, `${t.distResult}: ${fov.toFixed(0)}° (${t.distDefault} ${prev.toFixed(0)}°)`)], [{ key: 'save', label: t.save, primary: true }, { key: 'redo', label: t.redo }]);
    if (d === 'cancel') return false;
    if (d === 'save') {
      setFov(S[0].w, S[0].h, fov);
      setDistK(S[0].w, S[0].h, 1); // поле зрения новое: прежняя поправка по линейке недействительна
      env.refresh();
      return true;
    }
  }
}

// =====================================================================================
// Уточнение углов (по желанию): размер экрана по карте + сетка 3×3 по очереди каждым глазом.
// Размер экрана нужен только здесь, чтобы знать, где точки в миллиметрах. Расстояния он не касается.
// =====================================================================================
async function cardOnScreen(c: Ctx): Promise<number | 'cancel' | 'back'> {
  await stim.open(t.scrHow);
  const { w, h: hh } = stim.size();
  const portrait = hh > w; // карта (85,6 мм) может не поместиться в ширину телефона: тогда рамка вертикальная
  let L = Math.min(portrait ? hh * 0.62 : w * 0.5, 600); // длинная сторона рамки, CSS px
  const frame = document.getElementById('stimFrame') as HTMLElement;
  const ctl = document.getElementById('stimCtl') as HTMLElement;
  const lbl = h('span', { class: 'note' });
  const paint = () => {
    const short = L * CARD_RATIO;
    frame.hidden = false;
    frame.style.width = `${portrait ? short : L}px`;
    frame.style.height = `${portrait ? L : short}px`;
    frame.style.left = `${w / 2}px`;
    frame.style.top = `${hh * 0.08}px`;
    lbl.textContent = `${L.toFixed(0)} px`;
  };
  const bump = (d: number) => () => {
    L = Math.min(2000, Math.max(100, L + d));
    paint();
  };
  const r = await new Promise<number | 'cancel' | 'back'>((resolve) => {
    ctl.hidden = false;
    ctl.replaceChildren(
      h('button', { onclick: bump(-10) }, '−10'),
      h('button', { onclick: bump(-1) }, '−1'),
      lbl,
      h('button', { onclick: bump(1) }, '+1'),
      h('button', { onclick: bump(10) }, '+10'),
      h('button', { class: 'primary', onclick: () => resolve(mmPerCssPxFromCard(L)) }, t.scrDone),
      h('button', { onclick: () => resolve('back') }, t.back),
    );
    paint();
    void c.cancel.promise.then(() => resolve('cancel'));
  });
  await stim.close();
  return r;
}

async function stepScreen(c: Ctx, title: string): Promise<boolean> {
  const { screen } = c;
  if (screenValid() && app.screen) {
    const a = await screen(title, [why(t.whyLabel, t.scrWhy), p(`${t.scrSaved}: ${app.screen.mmPerCssPx.toFixed(3)} мм (${fmtDate(app.screen.at)}).`, 'big')], [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }]);
    if (a === 'cancel') return false;
    if (a === 'skip') return true;
  }
  for (;;) {
    const a = await screen(title, [why(t.whyLabel, t.scrWhy)], [{ key: 'go', label: t.start2, primary: true }]);
    if (a === 'cancel') return false;
    const r = await cardOnScreen(c);
    if (r === 'cancel') return false;
    if (r === 'back') continue;
    if (!(r > 0.06 && r < 0.5)) {
      const x = await screen(title, [p(t.scrBad, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
      if (x === 'cancel') return false;
      continue;
    }
    app.screen = { mmPerCssPx: r, dpr: window.devicePixelRatio, method: 'card', at: Date.now() };
    persist();
    const d = await screen(title, [p(`${t.scrResult}: ${r.toFixed(3)} мм`, 'big')], [{ key: 'next', label: t.next, primary: true }]);
    return d !== 'cancel';
  }
}

interface GridResult {
  h: GainFit;
  v: GainFit | null;
  z: number;
  points: number;
}

async function gridRun(c: Ctx, side: 'right' | 'left'): Promise<GridResult | 'cancel'> {
  const { env, cancel } = c;
  await stim.open('');
  for (let n = 3; n > 0; n--) {
    stim.msg(String(n), true);
    if (await wait(1000, cancel)) {
      await stim.close();
      return 'cancel';
    }
  }
  stim.msg('');
  const { w, h: hh } = stim.size();
  const spec: ScreenSpec = { mmPerCssPx: app.screen!.mmPerCssPx, widthCss: w, heightCss: hh, camOffsetMm: CAM_OFFSET_MM };
  const key = side === 'right' ? 'R' : 'L';
  let capturing = false;
  let target: [number, number, number] = [0, 0, 0];
  let frames: { mh: number; th: number; mv: number; tv: number; z: number }[] = [];
  const stop = collect((i) => {
    const open = side === 'right' ? i.openR : i.openL;
    if (!capturing || !i.face || !i.Rimg || !i.eyeCam || !(open >= 0.2)) return;
    const g = trueGazeDeg(i.eyeCam[key], target, i.Rimg, side);
    frames.push({ mh: i.rawH[key], th: g.h, mv: i.rawV[key], tv: g.v, z: i.z });
  });
  env.recorder.scene = `grid_${side}`;
  setBorder('green');
  const mh: number[] = [], th: number[] = [], mv: number[] = [], tv: number[] = [], zs: number[] = [], vars: number[] = [];
  let aborted = false;
  outer: for (const fy of GRID_FY)
    for (const fx of GRID_FX) {
      stim.dot(fx * w, fy * hh);
      capturing = false;
      if (await wait(SETTLE_MS, cancel)) {
        aborted = true;
        break outer;
      }
      target = screenToCam(fx * w, fy * hh, spec);
      frames = [];
      capturing = true;
      if (await wait(DWELL_MS, cancel)) {
        aborted = true;
        break outer;
      }
      capturing = false;
      if (frames.length >= 6) {
        const H = frames.map((x) => x.mh);
        const m = median(H);
        const varMed = (H.reduce((a, v) => a + (v - m) ** 2, 0) / (H.length - 1)) * (1.57 / H.length); // дисперсия медианы
        mh.push(m);
        th.push(median(frames.map((x) => x.th)));
        mv.push(median(frames.map((x) => x.mv)));
        tv.push(median(frames.map((x) => x.tv)));
        zs.push(median(frames.map((x) => x.z)));
        vars.push(varMed);
      }
    }
  stop();
  env.recorder.scene = null;
  const fullscreen = stim.fullscreen;
  await stim.close();
  if (aborted) {
    setBorder('off');
    return 'cancel';
  }
  setBorder('off');
  const varH = vars.length ? vars.reduce((a, v) => a + v, 0) / vars.length : 0;
  return { h: fitGain(mh, th, varH), v: fullscreen && mh.length ? fitGain(mv, tv) : null, z: zs.length ? median(zs) : NaN, points: mh.length };
}

export async function stepRefine(c: Ctx, title: string): Promise<boolean> {
  const { screen } = c;
  const w0 = app.lastInfo?.w ?? 0;
  const h0 = app.lastInfo?.h ?? 0;
  const g = app.gains;
  // 1) предложение: уточнение необязательно, пропуск есть всегда
  if (g) {
    const stale = g.fovAtFit !== undefined && w0 > 0 && Math.abs(currentFov(w0, h0) - g.fovAtFit) > 3;
    const a = await screen(
      title,
      [why(t.whyLabel, t.rfWhy), p(`${t.rfSaved} (${fmtDate(g.at)}): правый ${g.R.h.toFixed(2)}, левый ${g.L.h.toFixed(2)}.`, 'big'), stale && p(t.rfStale, 'warn')],
      stale ? [{ key: 'go', label: t.redo, primary: true }, { key: 'skip', label: t.skip }] : [{ key: 'skip', label: t.skip, primary: true }, { key: 'go', label: t.redo }],
    );
    if (a === 'cancel') return false;
    if (a === 'skip') return true;
  } else {
    const a = await screen(title, [why(t.whyLabel, t.rfWhy)], [{ key: 'go', label: t.rfGo, primary: true }, { key: 'skip', label: t.rfSkipNo }]);
    if (a === 'cancel') return false;
    if (a === 'skip') return true;
  }
  // 2) размер экрана (нужен только для этого шага)
  if (!(await stepScreen(c, title))) return false;

  // 3) сетка по очереди каждым глазом
  const fits: Record<'right' | 'left', { h: GainFit[]; v: GainFit[] }> = { right: { h: [], v: [] }, left: { h: [], v: [] } };
  const live = h('p', { class: 'big' }, '…');
  const timer = setInterval(() => {
    const z = app.lastInfo?.z;
    live.textContent = Number.isFinite(z) ? `${t.gridNow}: ${((z as number) / 10).toFixed(0)} см` : t.noFace;
  }, 300);
  const a0 = await screen(title, [p(t.gridDist), live, p(t.gridHow)], [{ key: 'go', label: t.start2, primary: true }]);
  clearInterval(timer);
  if (a0 === 'cancel') return false;

  for (const side of ['right', 'left'] as const) {
    for (;;) {
      const b = await screen(title, [p(side === 'right' ? t.gridCoverLeft : t.gridCoverRight, 'big'), p(t.gridEye)], [{ key: 'go', label: t.start2, primary: true }]);
      if (b === 'cancel') return false;
      const r = await gridRun(c, side);
      if (r === 'cancel') return false;
      const nodes: Node[] = [h('p', { class: 'big' }, `${side === 'right' ? t.right : t.left}: k = ${Number.isFinite(r.h.k) ? r.h.k.toFixed(2) : 'n/a'}`)];
      nodes.push(p(`${t.gridPoints}: ${r.points} из 9, ${t.gridRange} ${r.h.rangeDeg.toFixed(1)}°, ${t.gridResid} ${Number.isFinite(r.h.rms) ? r.h.rms.toFixed(2) : 'n/a'}°, ${t.dist} ${Number.isFinite(r.z) ? (r.z / 10).toFixed(0) : 'n/a'} см.`));
      if (r.z / 10 < 25 || r.z / 10 > 55) nodes.push(p(t.gridWrongDist, 'warn'));
      if (r.h.rangeDeg < 10) nodes.push(p(t.gridNarrow, 'warn'));
      if (!r.h.ok) nodes.push(p(t.gridFitBad, 'warn'));
      if (!r.v) nodes.push(p(t.gridNoVertical));
      const d = await screen(title, nodes, r.h.ok ? [{ key: 'save', label: t.next, primary: true }, { key: 'redo', label: t.redo }] : [{ key: 'redo', label: t.redo, primary: true }, { key: 'save', label: t.gridKeep }]);
      if (d === 'cancel') return false;
      if (d === 'save') {
        if (r.h.ok) fits[side].h.push(r.h);
        if (r.v && r.v.ok) fits[side].v.push(r.v);
        break;
      }
    }
  }

  const kR = combineGains(fits.right.h);
  const kL = combineGains(fits.left.h);
  if (!kR || !kL) {
    const x = await screen(title, [p(t.rfFail, 'warn')], [{ key: 'next', label: t.next, primary: true }]);
    return x !== 'cancel';
  }
  const vR = combineGains(fits.right.v);
  const vL = combineGains(fits.left.v);
  setGains({ R: { h: kR.k, v: vR?.k ?? 1 }, L: { h: kL.k, v: vL?.k ?? 1 }, at: Date.now(), fovAtFit: w0 ? currentFov(w0, h0) : undefined });
  c.env.refresh();
  const d = await screen(title, [h('p', { class: 'big' }, `${t.right}: k = ${kR.k.toFixed(2)}, ${t.left}: k = ${kL.k.toFixed(2)}`), p(t.rfDoneText)], [{ key: 'next', label: t.next, primary: true }]);
  return d !== 'cancel';
}
