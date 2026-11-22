// Точная калибровка (M2): поле зрения камеры, размер пикселя экрана, коэффициенты глаз по сетке 3×3.
import type { Env } from './calibration';
import { combineGains, fitGain, type GainFit } from './core/eyeFit';
import { median } from './core/filters';
import { rToEuler } from './core/linalg';
import { focalFromKnownDistance, fovFromFocal, isPlausibleFov } from './core/scale';
import { ScreenSpec, mmPerCssPxFromCard, mmPerCssPxFromDiagonal, screenToCam, trueGazeDeg } from './core/screenGeom';
import { t } from './i18n';
import { FrameInfo, app, currentFov, fovCalibrated, persist, screenValid, setFov, setGains } from './state';
import { stim } from './stim';
import { Cancel, h, setBorder, sheet, timedCapture, wait } from './ui';
import { fmtDate, makeScreen, p, why } from './wizard';

const CARD_RATIO = 53.98 / 85.6;
const NEAR_CM: [number, number] = [30, 50];
const FAR_CM: [number, number] = [50, 75];
const GRID_FX = [0.1, 0.5, 0.9];
const GRID_FY = [0.12, 0.5, 0.88];
const SETTLE_MS = 800;
const DWELL_MS = 1500;
const CAM_OFFSET_MM = 4; // центр камеры ниже верхнего края экрана (во весь экран); стартовое значение

function collect(cb: (i: FrameInfo) => void): () => void {
  app.sinks.add(cb);
  return () => app.sinks.delete(cb);
}

export async function runPrecise(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    void stim.close();
    env.recorder.scene = null;
  });
  const screen = makeScreen(cancel);
  const title = (n: number, name: string) => t.preciseStep(n, name);

  if (!(await env.ensureCamera())) {
    sheet.set(title(1, t.p1Name), p(t.needCamera));
    return;
  }
  if (!app.irisAt || !app.model) {
    await screen(t.menuPrecise, [p(t.pNeedBasic, 'warn')], [{ key: 'close', label: t.close, primary: true }]);
    sheet.close();
    return;
  }
  env.recorder.clear();

  // ---------------- шаг 1: поле зрения камеры ----------------
  async function stepFov(): Promise<boolean> {
    const t1 = title(1, t.p1Name);
    const w0 = app.lastInfo?.w ?? 0;
    const h0 = app.lastInfo?.h ?? 0;
    if (w0 && fovCalibrated(w0, h0)) {
      const a = await screen(t1, [why(t.whyLabel, t.p1Why), p(`${t.p1Saved}: ${currentFov(w0, h0).toFixed(0)}° (${w0}×${h0}).`, 'big')], [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }]);
      if (a === 'cancel') return false;
      if (a === 'skip') return true;
    }
    for (;;) {
      const input = h('input', { type: 'number', min: '20', max: '100', step: '1', value: '40' });
      const a = await screen(t1, [why(t.whyLabel, t.p1Why), p(t.p1How), h('p', null, input, ' см')], [{ key: 'go', label: t.start2, primary: true }, { key: 'skipall', label: t.skip }]);
      if (a === 'cancel') return false;
      if (a === 'skipall') return true;
      const zMm = Number(input.value) * 10;
      if (!(zMm >= 200 && zMm <= 1000)) continue;
      sheet.set(t1, p(t.p1Wait, 'big'));
      const S: { irisPx: number; w: number; h: number }[] = [];
      const stop = collect((i) => {
        if (i.face && i.valid && i.Rimg && Math.abs(rToEuler(i.Rimg).yaw) < 8) S.push(i);
      });
      const ok = await timedCapture({ prep: 3, duration: 4, cancel, onStart: () => (env.recorder.scene = 'fov'), onEnd: () => (env.recorder.scene = null) });
      stop();
      if (!ok) return false;
      if (S.length < 8) {
        const r = await screen(t1, [p(t.p1Few, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
        if (r === 'cancel') return false;
        continue;
      }
      const irisPx = median(S.map((x) => x.irisPx));
      const f = focalFromKnownDistance(irisPx, app.iris.irisMm, zMm);
      const fov = fovFromFocal(S[0].h, f);
      if (!isPlausibleFov(fov)) {
        const r = await screen(t1, [p(`${t.p1Bad} (${fov.toFixed(0)}°)`, 'warn')], [{ key: 'retry', label: t.redo, primary: true }, { key: 'skipall', label: t.skip }]);
        if (r === 'cancel') return false;
        if (r === 'skipall') return true;
        continue;
      }
      const c = await screen(t1, [h('p', { class: 'big' }, `${t.p1Result}: ${fov.toFixed(0)}° (${t.p1Default} ${currentFov(S[0].w, S[0].h).toFixed(0)}°)`)], [{ key: 'save', label: t.save, primary: true }, { key: 'redo', label: t.redo }]);
      if (c === 'cancel') return false;
      if (c === 'save') {
        setFov(S[0].w, S[0].h, fov);
        env.refresh();
        return true;
      }
    }
  }

  // ---------------- шаг 2: размер пикселя экрана ----------------
  async function cardOnScreen(): Promise<number | 'cancel' | 'back'> {
    await stim.open(t.p2StimMsg);
    const { w, h: hh } = stim.size();
    const portrait = hh > w;
    let L = Math.min(portrait ? hh * 0.62 : w * 0.5, 600); // длинная сторона рамки, CSS px
    const frame = document.getElementById('stimFrame') as HTMLElement;
    const ctl = document.getElementById('stimCtl') as HTMLElement;
    const lbl = h('span', { class: 'note' });
    const paint = () => {
      const long = L;
      const short = L * CARD_RATIO;
      frame.hidden = false;
      frame.style.width = `${portrait ? short : long}px`;
      frame.style.height = `${portrait ? long : short}px`;
      frame.style.left = `${w / 2}px`;
      frame.style.top = `${hh * 0.08}px`;
      lbl.textContent = `${L.toFixed(0)} px`;
    };
    const bump = (d: number) => () => {
      L = Math.min(2000, Math.max(100, L + d));
      paint();
    };
    return new Promise((resolve) => {
      ctl.hidden = false;
      ctl.replaceChildren(
        h('button', { onclick: bump(-10) }, '−10'),
        h('button', { onclick: bump(-1) }, '−1'),
        lbl,
        h('button', { onclick: bump(1) }, '+1'),
        h('button', { onclick: bump(10) }, '+10'),
        h('button', { class: 'primary', onclick: () => resolve(mmPerCssPxFromCard(L)) }, t.p2Done),
        h('button', { onclick: () => resolve('back') }, t.back),
      );
      paint();
      void cancel.promise.then(() => resolve('cancel'));
    }).then(async (r) => {
      await stim.close();
      return r as number | 'cancel' | 'back';
    });
  }

  async function stepScreen(): Promise<boolean> {
    const t2 = title(2, t.p2Name);
    if (screenValid() && app.screen) {
      const a = await screen(t2, [why(t.whyLabel, t.p2Why), p(`${t.p2Saved}: ${app.screen.mmPerCssPx.toFixed(3)} мм (${app.screen.method === 'card' ? t.p2ByCard : t.p2ByDiag}, ${fmtDate(app.screen.at)}).`, 'big')], [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }]);
      if (a === 'cancel') return false;
      if (a === 'skip') return true;
    }
    for (;;) {
      const m = await screen(t2, [why(t.whyLabel, t.p2Why), p(t.p2Pick)], [{ key: 'card', label: t.p2Card, primary: true }, { key: 'diag', label: t.p2Diag }]);
      if (m === 'cancel') return false;
      let mm = NaN;
      let method: 'card' | 'diagonal' = 'card';
      if (m === 'card') {
        const r = await cardOnScreen();
        if (r === 'cancel') return false;
        if (r === 'back') continue;
        mm = r;
      } else {
        method = 'diagonal';
        const input = h('input', { type: 'number', min: '3', max: '40', step: '0.1', placeholder: '6.8' });
        const a = await screen(t2, [p(t.p2DiagHow), h('p', null, input, ' ″')], [{ key: 'save', label: t.save, primary: true }, { key: 'back', label: t.back }]);
        if (a === 'cancel') return false;
        if (a === 'back') continue;
        mm = mmPerCssPxFromDiagonal(Number(input.value), window.screen.width, window.screen.height);
      }
      if (!(mm > 0.06 && mm < 0.5)) {
        const r = await screen(t2, [p(t.p2Bad, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
        if (r === 'cancel') return false;
        continue;
      }
      app.screen = { mmPerCssPx: mm, dpr: window.devicePixelRatio, method, at: Date.now() };
      persist();
      const d = await screen(t2, [p(`${t.p2Result}: ${mm.toFixed(3)} мм`, 'big')], [{ key: 'next', label: t.next, primary: true }]);
      return d !== 'cancel';
    }
  }

  // ---------------- шаг 3-4: коэффициенты глаз ----------------
  interface GridResult {
    side: 'right' | 'left';
    h: GainFit;
    v: GainFit | null;
    z: number;
    points: number;
  }

  async function gridRun(side: 'right' | 'left', tag: string): Promise<GridResult | 'cancel'> {
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
    let capturing = false;
    let target: [number, number, number] = [0, 0, 0];
    let frames: { mh: number; th: number; mv: number; tv: number; z: number }[] = [];
    const stop = collect((i) => {
      const open = side === 'right' ? i.openR : i.openL;
      if (!capturing || !i.face || !i.Rimg || !i.eyeCam || !(open >= 0.2)) return;
      const g = trueGazeDeg(i.eyeCam[side === 'right' ? 'R' : 'L'], target, i.Rimg, side);
      frames.push({ mh: i.rawH[side === 'right' ? 'R' : 'L'], th: g.h, mv: i.rawV[side === 'right' ? 'R' : 'L'], tv: g.v, z: i.z });
    });
    env.recorder.scene = `grid_${side}_${tag}`;
    setBorder('red');
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
    setBorder('green');
    const varH = vars.length ? vars.reduce((a, v) => a + v, 0) / vars.length : 0;
    return { side, h: fitGain(mh, th, varH), v: fullscreen && mh.length ? fitGain(mv, tv) : null, z: zs.length ? median(zs) : NaN, points: mh.length };
  }

  const fits: Record<'right' | 'left', { h: GainFit[]; v: GainFit[] }> = { right: { h: [], v: [] }, left: { h: [], v: [] } };
  const info: string[] = [];

  async function stepGrid(n: number, tag: 'near' | 'far', range: [number, number], optional: boolean): Promise<boolean> {
    const t3 = title(n, tag === 'near' ? t.p3NearName : t.p3FarName);
    const rangeTxt = `${range[0]}–${range[1]} см`;
    const live = h('p', { class: 'big' }, '…');
    const timer = setInterval(() => {
      const z = app.lastInfo?.z;
      live.textContent = Number.isFinite(z) ? `${t.p3Now}: ${((z as number) / 10).toFixed(0)} см` : t.noFace;
    }, 300);
    const a = await screen(t3, [why(t.whyLabel, t.p3Why), p(`${t.p3Dist} ${rangeTxt}.`), live, p(t.p3How)], [
      { key: 'go', label: t.start2, primary: true },
      ...(optional ? [{ key: 'skip', label: t.skip }] : []),
    ]);
    clearInterval(timer);
    if (a === 'cancel') return false;
    if (a === 'skip') return true;

    for (const side of ['right', 'left'] as const) {
      for (;;) {
        const covered = side === 'right' ? t.p3CoverLeft : t.p3CoverRight;
        const b = await screen(t3, [p(covered, 'big'), p(t.p3Eye)], [{ key: 'go', label: t.start2, primary: true }]);
        if (b === 'cancel') return false;
        const r = await gridRun(side, tag);
        if (r === 'cancel') return false;
        const nodes: Node[] = [h('p', { class: 'big' }, `${side === 'right' ? t.right : t.left}: k = ${Number.isFinite(r.h.k) ? r.h.k.toFixed(2) : 'n/a'}`)];
        nodes.push(p(`${t.p3Points}: ${r.points} из 9, ${t.p3Range} ${r.h.rangeDeg.toFixed(1)}°, ${t.p3Resid} ${Number.isFinite(r.h.rms) ? r.h.rms.toFixed(2) : 'n/a'}°, ${t.dist} ${Number.isFinite(r.z) ? (r.z / 10).toFixed(0) : 'n/a'} см.`));
        if (r.z / 10 < range[0] - 5 || r.z / 10 > range[1] + 5) nodes.push(p(t.p3WrongDist, 'warn'));
        if (r.h.rangeDeg < 10) nodes.push(p(t.p3NarrowRange, 'warn'));
        if (!r.h.ok) nodes.push(p(t.p3FitBad, 'warn'));
        if (!r.v) nodes.push(p(t.p3NoVertical));
        const c = await screen(t3, nodes, r.h.ok ? [{ key: 'save', label: t.next, primary: true }, { key: 'redo', label: t.redo }] : [{ key: 'redo', label: t.redo, primary: true }, { key: 'save', label: t.p3KeepAnyway }]);
        if (c === 'cancel') return false;
        if (c === 'save') {
          if (r.h.ok) fits[side].h.push(r.h);
          if (r.v && r.v.ok) fits[side].v.push(r.v);
          info.push(`${tag} ${side}: k=${r.h.k.toFixed(2)} r2=${r.h.r2.toFixed(2)} range=${r.h.rangeDeg.toFixed(1)}`);
          break;
        }
      }
    }
    return true;
  }

  if (!(await stepFov())) return;
  if (!(await stepScreen())) return;
  if (!(await stepGrid(3, 'near', NEAR_CM, false))) return;
  if (!(await stepGrid(4, 'far', FAR_CM, true))) return;

  // ---------------- итог ----------------
  const kR = combineGains(fits.right.h);
  const kL = combineGains(fits.left.h);
  if (!kR || !kL) {
    await screen(t.preciseDone, [p(t.pFail, 'warn')], [{ key: 'close', label: t.close, primary: true }]);
    sheet.close();
    return;
  }
  const vR = combineGains(fits.right.v);
  const vL = combineGains(fits.left.v);
  setGains({ R: { h: kR.k, v: vR?.k ?? 1 }, L: { h: kL.k, v: vL?.k ?? 1 }, at: Date.now(), info: info.join('; ') });
  env.refresh();
  const nodes: Node[] = [
    h('p', { class: 'big' }, `${t.right}: k = ${kR.k.toFixed(2)}, ${t.left}: k = ${kL.k.toFixed(2)}`),
    p(t.pDoneText),
  ];
  if (Math.max(kR.spread, kL.spread) > 0.15) nodes.push(p(t.pSpread, 'warn'));
  for (;;) {
    const a = await screen(t.preciseDone, nodes, [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (a === 'csv') env.recorder.download('precise');
    else break;
  }
  sheet.close();
}
