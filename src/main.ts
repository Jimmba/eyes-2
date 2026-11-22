import { DrawingUtils, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { runCalibration, type Env } from './calibration';
import { runPrecise } from './precise';
import { runMeasure, runTraining } from './training';
import { onVideoFrame, startCamera, type CameraHandle } from './camera';
import { CardMarker } from './cardMark';
import { state } from './config';
import { CONVENTIONS, RIGID_IDX, conventionById, fitScale, toMm } from './core/faceModel';
import { TimeWindow, windowStat } from './core/filters';
import { angleDeg, binocular, cornersMidCam, deviationDeg, eyeOffsetMm, interEyeMm, prismDiopters } from './core/gaze';
import { eyeCenterCam } from './core/screenGeom';
import { mpMatrixToR } from './core/linalg';
import { distanceMm, focalFromVerticalFov } from './core/scale';
import { measureEye, median, poseFromMatrix, std, type EyeRaw, type EyeSide } from './geometry';
import { t } from './i18n';
import { Recorder } from './recorder';
import { saveSnapshot } from './snapshot';
import { FrameInfo, app, currentFov, effectiveModel, fovCalibrated, loadGainsForCamera, publish, resetAll, restore, zeroValid } from './state';
import { Cancel, timedCapture } from './ui';
import { createLandmarker, type Landmarker } from './vision';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const txt = (id: string, text: string) => ($(id).textContent = text);
const video = $<HTMLVideoElement>('video');
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const panel = $<HTMLPreElement>('panel');
const statusEl = $('status');
const startBtn = $<HTMLButtonElement>('start');
const devBox = $<HTMLInputElement>('dev');
const resSel = $<HTMLSelectElement>('res');
const dirSel = $<HTMLSelectElement>('dirSel');
const recBtn = $<HTMLButtonElement>('rec');
const snapBtn = $<HTMLButtonElement>('snap');
const durInput = $<HTMLInputElement>('dur');
const labelInput = $<HTMLInputElement>('label');
const recInfo = $('recInfo');
const menu = $('menu');
const chips = $('chips');
const cropCanvas: Record<EyeSide, HTMLCanvasElement> = { right: $('cropR'), left: $('cropL') };

const PREVIEW_W = 640; // превью и оверлей рисуем уменьшенными (быстрее), расчёты идут по полному кадру
const CROP_EVERY = 3; // окна глаз обновляем не каждый кадр

// ---- тексты ----
txt('title', t.title);
txt('disclaimer', t.disclaimer);
startBtn.textContent = t.start;
txt('miCalib', t.menuCalib);
txt('miCsv', t.menuCsv);
txt('miReset', t.menuReset);
txt('devSummary', t.menuDev);
txt('devLabel', t.dev);
txt('resLabel', t.resLabel);
txt('dirLabel', t.dirLabel);
(dirSel.options[0] as HTMLOptionElement).text = t.dirAway;
(dirSel.options[1] as HTMLOptionElement).text = t.dirCloser;
txt('miPrecise', t.menuPrecise);
txt('miMeasure', t.menuMeasure);
txt('miTrain', t.menuTrain);
txt('durLabel', t.durLabel);
recBtn.textContent = t.record;
snapBtn.textContent = t.snapshot;
labelInput.placeholder = t.labelPlaceholder;
recInfo.textContent = t.recHint;
txt('capR', t.eyeR);
txt('capL', t.eyeL);

const recorder = new Recorder();
const marker = new CardMarker(view);
const WINDOW = 30;
const hist: Record<EyeSide, { dx: number[]; dy: number[] }> = { right: { dx: [], dy: [] }, left: { dx: [], dy: [] } };
interface Sample { t: number; angR: number; angL: number; open: number; z: number; ipd: number }
const win = new TimeWindow<Sample>(1500);
let fps = 0;
let lastNow = 0;
let frameNo = 0;
let cam: CameraHandle | null = null;
let engine: Landmarker | null = null;
let stopLoop: (() => void) | null = null;
let lastPanelText = '';
let busy = false;

// ---- индикаторы вверху ----
function updateChips(): void {
  const iris = app.irisAt ? `${app.iris.irisMm.toFixed(1)} мм (${t.methodNames[app.iris.method]})` : `${app.iris.irisMm.toFixed(1)} мм (${t.methodNames.default})`;
  chips.textContent = `${t.chipIris}: ${iris} · ${t.chipModel}: ${app.model ? t.yes : t.no} · ${t.chipZero}: ${zeroValid() ? t.yes : t.no}`;
}

// ---- меню ----
$('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
});
devBox.addEventListener('change', () => {
  state.isDev = devBox.checked;
  $('devPanel').hidden = !state.isDev;
});
dirSel.addEventListener('change', () => {
  app.direction = dirSel.value === 'closer' ? 'closer' : 'away';
});

const env: Env = { ensureCamera, freezeFrame, marker, recorder, refresh: updateChips };
function menuAction(id: string, fn: (e: Env) => Promise<void>): void {
  $(id).addEventListener('click', async () => {
    menu.hidden = true;
    if (busy) return;
    busy = true;
    try {
      await fn(env);
    } finally {
      busy = false;
      marker.stop();
      recorder.scene = null;
      updateChips();
    }
  });
}
menuAction('miCalib', runCalibration);
menuAction('miPrecise', runPrecise);
menuAction('miMeasure', runMeasure);
menuAction('miTrain', runTraining);
$('miCsv').addEventListener('click', () => {
  menu.hidden = true;
  if (recorder.count === 0) alert(t.csvEmpty);
  else recorder.download('calibration');
});
$('miReset').addEventListener('click', () => {
  menu.hidden = true;
  if (confirm(t.menuResetAsk)) {
    resetAll();
    updateChips();
  }
});

// ---- камера ----
let starting: Promise<boolean> | null = null;
function ensureCamera(): Promise<boolean> {
  if (cam && engine) return Promise.resolve(true);
  starting ??= startAll().finally(() => (starting = null));
  return starting;
}
startBtn.addEventListener('click', () => void ensureCamera());

async function startAll(): Promise<boolean> {
  startBtn.disabled = true;
  statusEl.textContent = t.starting;
  try {
    if (!window.isSecureContext) throw new Error(t.noHttps);
    const size = resSel.value === '720' ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };
    cam = await startCamera(video, size);
    app.cameraKey = cam.stream.getVideoTracks()[0]?.label || 'camera';
    loadGainsForCamera();
    engine = await createLandmarker();
    statusEl.textContent = `${t.running}: ${cam.info}; ${engine.delegate}`;
    startBtn.hidden = true;
    resSel.disabled = true;
    stopLoop = onVideoFrame(video, processFrame);
    updateChips();
    return true;
  } catch (e) {
    console.error(e);
    statusEl.textContent = `${t.error}: ${(e as Error).message}`;
    startBtn.disabled = false;
    stopLoop?.();
    cam?.stop();
    cam = null;
    engine = null;
    return false;
  }
}

/** Полноразмерный кадр (для отметки углов карты). */
function freezeFrame(): HTMLCanvasElement | null {
  if (!video.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d')!.drawImage(video, 0, 0);
  return c;
}

// ---- запись сцены для разработчика (в тот же журнал) ----
recBtn.addEventListener('click', async () => {
  menu.hidden = true;
  if (busy) return;
  busy = true;
  try {
    if (!(await ensureCamera())) return;
    const dur = Math.min(60, Math.max(3, Number(durInput.value) || 10));
    const label = labelInput.value.trim() || 'dev';
    const ok = await timedCapture({ prep: 3, duration: dur, cancel: new Cancel(), onStart: () => (recorder.scene = `dev:${label}`), onEnd: () => (recorder.scene = null) });
    if (ok) recorder.download('record');
  } finally {
    busy = false;
  }
});

snapBtn.addEventListener('click', async () => {
  menu.hidden = true;
  if (busy) return;
  busy = true;
  try {
    if (!(await ensureCamera())) return;
    await timedCapture({ prep: 3, duration: 0, cancel: new Cancel() });
    saveSnapshot(view, cropCanvas.right, cropCanvas.left, lastPanelText || 'snapshot');
  } finally {
    busy = false;
  }
});

// ---------------- расчёт по кадру ----------------
const sg = (x: number, d = 1) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a');

function computeM1(lm: { x: number; y: number; z: number }[], w: number, h: number, res: FaceLandmarkerResult, i: number, R: EyeRaw, L: EyeRaw, now: number) {
  const irisPx = (R.irisDiamPx + L.irisDiamPx) / 2;
  const sIris = app.iris.irisMm / irisPx;
  const f = focalFromVerticalFov(h, currentFov(w, h));
  const mat = res.facialTransformationMatrixes?.[i];
  const Rraw = mat ? mpMatrixToR(mat.data) : null;
  const model = effectiveModel();
  const conv = conventionById(model?.convention ?? CONVENTIONS[0].id);
  const Rimg = Rraw ? conv.apply(Rraw) : null;

  let s = sIris;
  let sModel = NaN;
  let resid = NaN;
  if (model && Rimg) {
    const pts = RIGID_IDX.map((k) => ({ x: lm[k].x * w, y: lm[k].y * h }));
    const fit = fitScale(model.points, Rimg, pts, { f, cx: w / 2, cy: h / 2 });
    sModel = fit.mmPerPx;
    resid = fit.residualPx;
    s = sModel;
  }
  const z = distanceMm(f, s);
  const offR = eyeOffsetMm(lm, w, h, 'right', s, Rimg, f);
  const offL = eyeOffsetMm(lm, w, h, 'left', s, Rimg, f);
  const rawH = { R: angleDeg(offR.dxMm), L: angleDeg(offL.dxMm) };
  const rawV = { R: angleDeg(offR.dyMm), L: angleDeg(offL.dyMm) };
  const g = app.gains;
  const angR = rawH.R * (g?.R.h ?? 1);
  const angL = rawH.L * (g?.L.h ?? 1);
  const ipd = interEyeMm(lm, w, h, s, f);
  const open = Math.min(R.openness, L.openness);
  win.push({ t: now, angR, angL, open, z, ipd });

  const it = win.items;
  const op = it.map((x) => x.open);
  const stR = windowStat(it.map((x) => x.angR), op);
  const stL = windowStat(it.map((x) => x.angL), op);
  const stZ = windowStat(it.map((x) => x.z), op);
  const stI = windowStat(it.map((x) => x.ipd), op);
  const ok = stR.ok && stL.ok && stZ.ok;
  const valid = open >= Math.max(0.15, 0.75 * median(op));

  let devR = NaN, devL = NaN, verg = NaN, vers = NaN;
  if (zeroValid() && app.zero && ok) {
    devR = deviationDeg(stR.median, app.zero.R, stZ.median, app.zero.z, stI.median);
    devL = deviationDeg(stL.median, app.zero.L, stZ.median, app.zero.z, stI.median);
    ({ vergenceDeg: verg, versionDeg: vers } = binocular(devR, devL));
  }
  let devInst = NaN; // по одному кадру: для детектора срыва
  if (zeroValid() && app.zero) devInst = deviationDeg(angR, app.zero.R, z, app.zero.z, ipd) + deviationDeg(angL, app.zero.L, z, app.zero.z, ipd);

  const eyeCam = Rimg ? { R: eyeCenterCam(cornersMidCam(lm, w, h, 'right', s, f), Rimg), L: eyeCenterCam(cornersMidCam(lm, w, h, 'left', s, f), Rimg) } : undefined;
  const info: FrameInfo = { t: now, face: true, w, h, lm, Rraw, Rimg, irisPx, open, openR: R.openness, openL: L.openness, angR, angL, rawH, rawV, eyeCam, z, ipd, sIris, f, devInst, valid };
  const fovTxt = `${currentFov(w, h).toFixed(0)}°${fovCalibrated(w, h) ? '' : ' (по умолчанию)'}`;
  const lines = [
    `── M1 ── радужка ${app.iris.irisMm.toFixed(2)} мм (${t.methodNames[app.iris.method]}), FOV ${fovTxt}, режим ${Rimg ? '3D (поза)' : '2D (нет матрицы)'}`,
    `мм/px: радужка ${sIris.toFixed(4)}${model ? `, модель ${sModel.toFixed(4)} (невязка ${resid.toFixed(1)} px)` : ''}  → Z ${z.toFixed(0)} мм`,
    model ? `модель лица: конв. ${model.convention}, разброс ${model.spreadMm.toFixed(2)} мм, кадров ${model.frames}` : 'модель лица: нет',
    g ? `коэффициенты глаз: R ${g.R.h.toFixed(2)} L ${g.L.h.toFixed(2)} (по горизонтали)` : 'коэффициенты глаз: нет (1,00)',
    `угол к носу (1,5 с, ${stR.n}/${stR.total}${ok ? '' : ', НЕВАЛИДНО'}): R ${sg(stR.median)}° (${sg(prismDiopters(stR.median))} ПД)  L ${sg(stL.median)}° (${sg(prismDiopters(stL.median))} ПД)`,
    zeroValid() && app.zero
      ? `ноль: R ${sg(app.zero.R)}° L ${sg(app.zero.L)}° на ${app.zero.z.toFixed(0)} мм | ОТКЛОНЕНИЕ R ${sg(devR)}° L ${sg(devL)}° вергенция ${sg(verg)}° (${sg(prismDiopters(verg))} ПД) версия ${sg(vers)}° | по кадру ${sg(devInst)}°`
      : 'ноль: не задан',
  ];
  const ev = app.pendingEvent;
  app.pendingEvent = '';
  const csv: (number | string)[] = [s, z, angR, angL, devR, devL, verg, app.iris.method, app.iris.irisMm, devInst, ev];
  return { info, lines, csv };
}

function pickFace(res: FaceLandmarkerResult): number {
  let best = -1;
  let size = 0;
  res.faceLandmarks.forEach((lm, i) => {
    const s = Math.abs(lm[454].x - lm[234].x);
    if (s > size) {
      size = s;
      best = i;
    }
  });
  return best;
}

function push(side: EyeSide, e: EyeRaw): void {
  const h = hist[side];
  if (e.openness < 0.15) return;
  h.dx.push(e.dx);
  h.dy.push(e.dy);
  if (h.dx.length > WINDOW) {
    h.dx.shift();
    h.dy.shift();
  }
}

function drawCrop(side: EyeSide, e: EyeRaw): void {
  const c = cropCanvas[side];
  const g = c.getContext('2d')!;
  const sw = e.eyeWidthPx * 2.2;
  const sh = sw / 2;
  g.drawImage(video, e.irisCenterPx.x - sw / 2, e.irisCenterPx.y - sh / 2, sw, sh, 0, 0, c.width, c.height);
  const k = c.width / sw;
  g.strokeStyle = side === 'right' ? '#ff5252' : '#69f0ae';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(c.width / 2, c.height / 2, (e.irisDiamPx / 2) * k, 0, Math.PI * 2);
  g.moveTo(c.width / 2 - 8, c.height / 2);
  g.lineTo(c.width / 2 + 8, c.height / 2);
  g.moveTo(c.width / 2, c.height / 2 - 8);
  g.lineTo(c.width / 2, c.height / 2 + 8);
  g.stroke();
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d).padStart(d + 3) : '  n/a');

function eyeLines(name: string, side: EyeSide, e: EyeRaw): string {
  return (
    `${name}: dx ${f(e.dx)} dy ${f(e.dy)} (диам. радужки)\n` +
    `   мм: dx ${f(e.dxMm, 2)} dy ${f(e.dyMm, 2)}\n` +
    `   медиана ${WINDOW} кадров: dx ${f(median(hist[side].dx))}±${f(std(hist[side].dx))} dy ${f(median(hist[side].dy))}±${f(std(hist[side].dy))}\n` +
    `   радужка ${e.irisDiamPx.toFixed(1)} px, раскрытие ${e.openness.toFixed(2)}`
  );
}

function processFrame(now: number): void {
  if (!engine) return;
  if (lastNow) fps = fps ? fps * 0.9 + (1000 / (now - lastNow)) * 0.1 : 1000 / (now - lastNow);
  lastNow = now;
  frameNo++;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  const pw = PREVIEW_W;
  const ph = Math.round((PREVIEW_W * h) / w);
  if (view.width !== pw || view.height !== ph) {
    view.width = pw;
    view.height = ph;
  }
  if (marker.active) {
    marker.draw(ctx); // замороженный кадр с маркерами, детекцию не гоняем
    return;
  }
  const s = pw / w;
  ctx.drawImage(video, 0, 0, pw, ph);

  const res = engine.lm.detectForVideo(video, now);
  const i = pickFace(res);
  const f0 = focalFromVerticalFov(h, currentFov(w, h));
  if (i < 0) {
    publish({ t: now, face: false, w, h, irisPx: NaN, open: NaN, openR: NaN, openL: NaN, angR: NaN, angL: NaN, rawH: { R: NaN, L: NaN }, rawV: { R: NaN, L: NaN }, z: NaN, ipd: NaN, sIris: NaN, f: f0, devInst: NaN, valid: false });
    lastPanelText = `${t.noFace}\nfps ${fps.toFixed(1)}`;
    panel.textContent = lastPanelText;
    recorder.push([0, fps, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, '', NaN, NaN, '']);
    return;
  }
  const lm = res.faceLandmarks[i];
  const R = measureEye(lm, w, h, 'right');
  const L = measureEye(lm, w, h, 'left');
  push('right', R);
  push('left', L);
  const m1 = computeM1(lm, w, h, res, i, R, L, now);
  publish(m1.info);

  const pose = res.facialTransformationMatrixes?.[i] ? poseFromMatrix(res.facialTransformationMatrixes[i].data) : null;

  if (state.isDev) {
    const du = new DrawingUtils(ctx);
    du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_CONTOURS, { color: '#4dd0e1', lineWidth: 1 });
    du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: '#ff5252', lineWidth: 2 });
    du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: '#69f0ae', lineWidth: 2 });
    for (const [e, col] of [[R, '#ff5252'], [L, '#69f0ae']] as const) {
      const cx = e.irisCenterPx.x * s;
      const cy = e.irisCenterPx.y * s;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy);
      ctx.lineTo(cx + 8, cy);
      ctx.moveTo(cx, cy - 8);
      ctx.lineTo(cx, cy + 8);
      ctx.stroke();
    }
    if (frameNo % CROP_EVERY === 0) {
      drawCrop('right', R);
      drawCrop('left', L);
    }
    lastPanelText = [
      `лиц: ${res.faceLandmarks.length}  fps ${fps.toFixed(1)}  кадр ${w}×${h}${recorder.scene ? '  [' + recorder.scene + ']' : ''}`,
      eyeLines('ПРАВЫЙ (R)', 'right', R),
      eyeLines('ЛЕВЫЙ  (L)', 'left', L),
      `вергенция R+L = ${f(R.dx + L.dx)}   версия R−L = ${f(R.dx - L.dx)} (диам. радужки)`,
      pose ? `поза: yaw ${f(pose.yaw, 1)} pitch ${f(pose.pitch, 1)} roll ${f(pose.roll, 1)}  tz ${f(pose.tz, 1)}` : 'поза: нет матрицы',
      ...m1.lines,
    ].join('\n');
    panel.textContent = lastPanelText;
  } else {
    lastPanelText = `fps ${fps.toFixed(1)}`;
    panel.textContent = lastPanelText;
  }

  if (recorder.scene) {
    recorder.push([
      res.faceLandmarks.length, fps,
      R.dx, R.dy, R.openness, R.irisDiamPx,
      L.dx, L.dy, L.openness, L.irisDiamPx,
      pose?.yaw ?? NaN, pose?.pitch ?? NaN, pose?.roll ?? NaN, pose?.tz ?? NaN,
      ...m1.csv,
    ]);
  }
}

// ---- старт ----
restore();
state.isDev = devBox.checked;
$('devPanel').hidden = !state.isDev;
updateChips();
