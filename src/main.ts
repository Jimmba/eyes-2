import { DrawingUtils, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { onVideoFrame, startCamera, type CameraHandle } from './camera';
import { state } from './config';
import { measureEye, median, poseFromMatrix, std, type EyeRaw, type EyeSide } from './geometry';
import { t } from './i18n';
import { Recorder } from './recorder';
import { saveSnapshot } from './snapshot';
import { createLandmarker, type Landmarker } from './vision';
import { CONVENTIONS, FaceModelBuilder, RIGID_IDX, conventionById, fitScale, toMm, type FaceModel } from './core/faceModel';
import { TimeWindow, windowStat } from './core/filters';
import { angleDeg, binocular, deviationDeg, eyeOffsetMm, interEyeMm, prismDiopters } from './core/gaze';
import { mpMatrixToR } from './core/linalg';
import { CARD_HEIGHT_MM, CARD_WIDTH_MM, cardScale, defaultScale, distanceMm, focalFromVerticalFov, isPlausibleIris, manualScale, type ScaleSetup } from './core/scale';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const panel = $<HTMLPreElement>('panel');
const statusEl = $('status');
const startBtn = $<HTMLButtonElement>('start');
const devBox = $<HTMLInputElement>('dev');
const resSel = $<HTMLSelectElement>('res');
const recBtn = $<HTMLButtonElement>('rec');
const snapBtn = $<HTMLButtonElement>('snap');
const durInput = $<HTMLInputElement>('dur');
const labelInput = $<HTMLInputElement>('label');
const recInfo = $('recInfo');
const cropCanvas: Record<EyeSide, HTMLCanvasElement> = { right: $('cropR'), left: $('cropL') };
const scaleSel = $<HTMLSelectElement>('scaleMethod');
const irisInput = $<HTMLInputElement>('irisMm');
const cardInput = $<HTMLInputElement>('cardPx');
const cardBtn = $<HTMLButtonElement>('cardMeasure');
const fovInput = $<HTMLInputElement>('fov');
const buildBtn = $<HTMLButtonElement>('buildModel');
const zeroBtn = $<HTMLButtonElement>('setZero');
const resetZeroBtn = $<HTMLButtonElement>('resetZero');
const m1Info = $('m1Info');

const PREVIEW_W = 640; // превью и оверлей рисуем уменьшенными (быстрее), расчёты идут по полному кадру
const CROP_EVERY = 3; // окна глаз обновляем не каждый кадр

// i18n
$('title').textContent = t.title;
$('disclaimer').textContent = t.disclaimer;
startBtn.textContent = t.start;
$('devLabel').textContent = t.dev;
$('resLabel').textContent = t.resLabel;
$('durLabel').textContent = t.durLabel;
recBtn.textContent = t.record;
snapBtn.textContent = t.snapshot;
labelInput.placeholder = t.labelPlaceholder;
recInfo.textContent = t.recHint;
$('capR').textContent = t.eyeR;
$('capL').textContent = t.eyeL;
$('m1Title').textContent = t.m1Title;
$('scaleLabel').textContent = t.scaleLabel;
$('irisMmLabel').textContent = t.irisMmLabel;
$('cardLabel').textContent = t.cardLabel;
$('fovLabel').textContent = t.fovLabel;
(scaleSel.options[0] as HTMLOptionElement).text = t.scaleDefault;
(scaleSel.options[1] as HTMLOptionElement).text = t.scaleManual;
(scaleSel.options[2] as HTMLOptionElement).text = t.scaleCard;
cardBtn.textContent = t.cardMeasure;
buildBtn.textContent = t.buildModel;
zeroBtn.textContent = t.setZero;
resetZeroBtn.textContent = t.resetZero;

const recorder = new Recorder();
const WINDOW = 30; // кадров в окне статистики
const hist: Record<EyeSide, { dx: number[]; dy: number[] }> = {
  right: { dx: [], dy: [] },
  left: { dx: [], dy: [] },
};
let fps = 0;
let lastNow = 0;
let frameNo = 0;
let cam: CameraHandle | null = null;
let engine: Landmarker | null = null;
let stopLoop: (() => void) | null = null;
let runningStatus = '';
let lastPanelText = '';
let busy = false;
let recTimer: ReturnType<typeof setTimeout> | null = null;
let recEnd = 0;

devBox.addEventListener('change', () => {
  state.isDev = devBox.checked;
});

// --- звук и вибрация: подсказки, чтобы не смотреть на экран ---
let audio: AudioContext | null = null;
function beep(freq = 880, ms = 150): void {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.2;
    o.frequency.value = freq;
    o.connect(gain).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + ms / 1000);
  } catch {
    /* звук недоступен */
  }
}
const vibrate = (p: number | number[]) => navigator.vibrate?.(p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function countdown(sec: number, label: string): Promise<void> {
  for (let i = sec; i > 0; i--) {
    statusEl.textContent = `${label} ${i}…`;
    beep(600, 80);
    await sleep(1000);
  }
  statusEl.textContent = runningStatus;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  resSel.disabled = true;
  statusEl.textContent = t.starting;
  try {
    if (!window.isSecureContext) throw new Error(t.noHttps);
    audio ??= new AudioContext(); // создаём по жесту пользователя
    const size = resSel.value === '720' ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };
    cam = await startCamera(video, size);
    engine = await createLandmarker();
    runningStatus = `${t.running}: ${cam.info}; ${engine.delegate}`;
    statusEl.textContent = runningStatus;
    recBtn.disabled = false;
    snapBtn.disabled = false;
    cardBtn.disabled = false;
    buildBtn.disabled = false;
    zeroBtn.disabled = false;
    resetZeroBtn.disabled = false;
    stopLoop = onVideoFrame(video, processFrame);
  } catch (e) {
    console.error(e);
    statusEl.textContent = `${t.error}: ${(e as Error).message}`;
    startBtn.disabled = false;
    resSel.disabled = false;
    stopLoop?.();
    cam?.stop();
  }
});

function finishRecording(): void {
  if (!recorder.active) return;
  if (recTimer) clearTimeout(recTimer);
  recTimer = null;
  beep(440, 300);
  vibrate([120, 80, 120]);
  recorder.stopAndDownload();
  recBtn.textContent = t.record;
  recInfo.textContent = t.recHint;
}

// Запись по таймеру: 3 с на то, чтобы занять позу, затем автостоп. Отводить взгляд для остановки не нужно.
recBtn.addEventListener('click', async () => {
  if (recorder.active) {
    finishRecording();
    return;
  }
  if (busy) return;
  busy = true;
  const dur = Math.min(60, Math.max(3, Number(durInput.value) || 10));
  await countdown(3, t.startIn);
  recorder.start();
  beep(1000, 200);
  vibrate(200);
  recBtn.textContent = t.recordStop;
  recEnd = performance.now() + dur * 1000;
  recTimer = setTimeout(finishRecording, dur * 1000);
  busy = false;
});

// Снимок с задержкой: нажали, заняли позу, получили PNG с метками для проверки глазами.
snapBtn.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  await countdown(3, t.snapIn);
  beep(1000, 200);
  vibrate(200);
  saveSnapshot(view, cropCanvas.right, cropCanvas.left, lastPanelText || `${labelInput.value}`);
  busy = false;
});


// ---------------- M1: масштаб, модель лица, углы, личный ноль ----------------
interface Sample { t: number; angR: number; angL: number; open: number; z: number; ipd: number; irisPx: number }
const win = new TimeWindow<Sample>(1500);
const builder = new FaceModelBuilder();
let scaleSetup: ScaleSetup = defaultScale();
let model: FaceModel | null = null;
let building = false;
let zero: { R: number; L: number; z: number } | null = null;
let lastStats: { R: number; L: number; z: number; ok: boolean } = { R: NaN, L: NaN, z: NaN, ok: false };
const M1_EMPTY: (number | string)[] = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, '', NaN];
const fovDeg = () => Math.min(100, Math.max(40, Number(fovInput.value) || 63));
const scaleLabelText = () =>
  `${scaleSetup.irisMm.toFixed(2)} мм (${scaleSetup.method === 'default' ? 'по умолчанию' : scaleSetup.method === 'manual' ? 'ввод' : 'карта'})`;
const showInfo = (msg = '') => {
  m1Info.textContent = msg;
};

scaleSel.addEventListener('change', () => {
  if (scaleSel.value === 'default') {
    scaleSetup = defaultScale();
    showInfo();
  } else if (scaleSel.value === 'manual') applyManual();
  else showInfo(t.cardHint);
});
irisInput.addEventListener('change', () => {
  if (scaleSel.value === 'manual') applyManual();
});
function applyManual(): void {
  try {
    scaleSetup = manualScale(Number(irisInput.value));
    showInfo();
  } catch (e) {
    showInfo((e as Error).message);
  }
}

cardBtn.addEventListener('click', () => {
  const px = win.items.map((x) => x.irisPx).filter(Number.isFinite);
  if (px.length < 8) return showInfo(t.cardFail);
  const sorted = [...px].sort((a, b) => a - b);
  const irisPx = sorted[sorted.length >> 1];
  const setup = cardScale(irisPx, Number(cardInput.value));
  if (!isPlausibleIris(setup.irisMm)) return showInfo(`${t.cardBad} (${setup.irisMm.toFixed(1)} мм)`);
  scaleSetup = setup;
  irisInput.value = setup.irisMm.toFixed(2);
  showInfo(`${t.cardOk}: ${setup.irisMm.toFixed(2)} мм`);
});

buildBtn.addEventListener('click', async () => {
  if (busy || !engine) return;
  busy = true;
  builder.reset();
  model = null;
  await countdown(3, t.startIn);
  building = true;
  beep(1000, 200);
  for (let k = 8; k > 0; k--) {
    statusEl.textContent = `${t.modelBuilding} ${k}…`;
    await sleep(1000);
  }
  building = false;
  beep(440, 300);
  statusEl.textContent = runningStatus;
  const m = builder.build();
  if (!m) showInfo(t.modelFail);
  else {
    model = m;
    showInfo(m.poseVariationOk ? '' : t.modelWarn);
  }
  busy = false;
});

zeroBtn.addEventListener('click', () => {
  if (!lastStats.ok) return showInfo(t.zeroFail);
  zero = { R: lastStats.R, L: lastStats.L, z: lastStats.z };
  showInfo(`${t.zeroOk}: R ${lastStats.R.toFixed(1)}°, L ${lastStats.L.toFixed(1)}°, ${lastStats.z.toFixed(0)} мм`);
});
resetZeroBtn.addEventListener('click', () => {
  zero = null;
  showInfo();
});

const sg = (x: number, d = 1) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a');

function computeM1(lm: { x: number; y: number; z: number }[], w: number, h: number, res: FaceLandmarkerResult, i: number, R: EyeRaw, L: EyeRaw, now: number): { lines: string[]; csv: (number | string)[]; s: number } {
  const irisPx = (R.irisDiamPx + L.irisDiamPx) / 2;
  const sIris = scaleSetup.irisMm / irisPx;
  const f = focalFromVerticalFov(h, fovDeg());
  const mat = res.facialTransformationMatrixes?.[i];
  const Rraw = mat ? mpMatrixToR(mat.data) : null;
  const conv = conventionById(model?.convention ?? CONVENTIONS[0].id);
  const Rimg = Rraw ? conv.apply(Rraw) : null;
  if (building && Rraw) builder.add(toMm(lm, RIGID_IDX, w, h, sIris, f), Rraw);

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
  const angR = angleDeg(eyeOffsetMm(lm, w, h, 'right', s, Rimg, f).dxMm);
  const angL = angleDeg(eyeOffsetMm(lm, w, h, 'left', s, Rimg, f).dxMm);
  const ipd = interEyeMm(lm, w, h, s, f);
  win.push({ t: now, angR, angL, open: Math.min(R.openness, L.openness), z, ipd, irisPx });

  const it = win.items;
  const open = it.map((x) => x.open);
  const stR = windowStat(it.map((x) => x.angR), open);
  const stL = windowStat(it.map((x) => x.angL), open);
  const stZ = windowStat(it.map((x) => x.z), open);
  const stI = windowStat(it.map((x) => x.ipd), open);
  const ok = stR.ok && stL.ok && stZ.ok;
  lastStats = { R: stR.median, L: stL.median, z: stZ.median, ok };

  let devR = NaN, devL = NaN, verg = NaN, vers = NaN;
  if (zero && ok) {
    devR = deviationDeg(stR.median, zero.R, stZ.median, zero.z, stI.median);
    devL = deviationDeg(stL.median, zero.L, stZ.median, zero.z, stI.median);
    ({ vergenceDeg: verg, versionDeg: vers } = binocular(devR, devL));
  }

  const lines = [
    `── M1 ── радужка ${scaleLabelText()}, FOV ${fovDeg()}°, режим ${Rimg ? '3D (поза)' : '2D (нет матрицы)'}`,
    `мм/px: радужка ${sIris.toFixed(4)}${model ? `, модель ${sModel.toFixed(4)} (невязка ${resid.toFixed(1)} px)` : ''}  → Z ${z.toFixed(0)} мм`,
    model
      ? `модель лица: конв. ${model.convention}, разброс ${model.spreadMm.toFixed(2)} мм, кадров ${model.frames}, yaw ${model.yawRangeDeg.toFixed(0)}° pitch ${model.pitchRangeDeg.toFixed(0)}°${model.poseVariationOk ? '' : ' (мало поворотов!)'}`
      : building
        ? `модель лица: собираю кадры ${builder.count}…`
        : 'модель лица: не построена (углы считаются по масштабу радужки, конвенция по умолчанию)',
    `угол к носу (медиана 1,5 с, ${stR.n}/${stR.total} кадров${ok ? '' : ', НЕВАЛИДНО'}): R ${sg(stR.median)}° (${sg(prismDiopters(stR.median))} ПД) ±${sg(stR.std, 2).replace('+', '')}  L ${sg(stL.median)}° (${sg(prismDiopters(stL.median))} ПД) ±${sg(stL.std, 2).replace('+', '')}`,
    zero
      ? `ноль: R ${sg(zero.R)}° L ${sg(zero.L)}° на ${zero.z.toFixed(0)} мм`
      : 'ноль: не задан (смотрите двумя глазами в камеру и нажмите «Задать ноль»)',
    zero
      ? `ОТКЛОНЕНИЕ: R ${sg(devR)}° L ${sg(devL)}° | вергенция ${sg(verg)}° (${sg(prismDiopters(verg))} ПД; + к носу, − к виску) версия ${sg(vers)}°`
      : '',
  ].filter(Boolean);

  const csv: (number | string)[] = [s, z, angR, angL, devR, devL, verg, scaleSetup.method, scaleSetup.irisMm];
  return { lines, csv, s };
}

function pickFace(res: FaceLandmarkerResult): number {
  let best = -1;
  let size = 0;
  res.faceLandmarks.forEach((lm, i) => {
    const s = Math.abs(lm[454].x - lm[234].x); // ширина лица по скулам
    if (s > size) {
      size = s;
      best = i;
    }
  });
  return best;
}

function push(side: EyeSide, e: EyeRaw): void {
  const h = hist[side];
  if (e.openness < 0.15) return; // грубо исключаем моргание
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
  const mx = median(hist[side].dx);
  const my = median(hist[side].dy);
  return (
    `${name}: dx ${f(e.dx)} dy ${f(e.dy)} (диам. радужки)\n` +
    `   мм: dx ${f(e.dxMm, 2)} dy ${f(e.dyMm, 2)}\n` +
    `   медиана ${WINDOW} кадров: dx ${f(mx)}±${f(std(hist[side].dx))} dy ${f(my)}±${f(std(hist[side].dy))}\n` +
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
  const s = pw / w;
  ctx.drawImage(video, 0, 0, pw, ph);

  const res = engine.lm.detectForVideo(video, now);
  const i = pickFace(res);
  if (i < 0) {
    lastPanelText = `${t.noFace}\nfps ${fps.toFixed(1)}`;
    panel.textContent = lastPanelText;
    recorder.push(labelInput.value, [0, fps, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, ...M1_EMPTY]);
    return;
  }
  const lm = res.faceLandmarks[i];
  const R = measureEye(lm, w, h, 'right'); // пиксели полного кадра
  const L = measureEye(lm, w, h, 'left');
  push('right', R);
  push('left', L);
  const m1 = computeM1(lm, w, h, res, i, R, L, now);

  const pose = res.facialTransformationMatrixes?.[i]
    ? poseFromMatrix(res.facialTransformationMatrixes[i].data)
    : null;

  if (state.isDev) {
    const du = new DrawingUtils(ctx);
    if (scaleSel.value === 'card') {
      const cw = Number(cardInput.value) * s;
      const ch = (cw * CARD_HEIGHT_MM) / CARD_WIDTH_MM;
      ctx.save();
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect((pw - cw) / 2, (ph - ch) / 2, cw, ch);
      ctx.restore();
    }
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

    // dx обоих глаз «к носу > 0»: сумма = вергенция (сведение/разведение), разность = версия (общий поворот взгляда)
    const vergence = R.dx + L.dx;
    const version = R.dx - L.dx;
    lastPanelText = [
      `лиц: ${res.faceLandmarks.length}  fps ${fps.toFixed(1)}  кадр ${w}×${h}${labelInput.value ? '  [' + labelInput.value + ']' : ''}`,
      eyeLines('ПРАВЫЙ (R)', 'right', R),
      eyeLines('ЛЕВЫЙ  (L)', 'left', L),
      `вергенция R+L = ${f(vergence)}   версия R−L = ${f(version)} (диам. радужки)`,
      pose
        ? `поза: yaw ${f(pose.yaw, 1)} pitch ${f(pose.pitch, 1)} roll ${f(pose.roll, 1)}  tz ${f(pose.tz, 1)}`
        : 'поза: нет матрицы',
      ...m1.lines,
    ].join('\n');
    panel.textContent = lastPanelText;
  } else {
    lastPanelText = `fps ${fps.toFixed(1)}`;
    panel.textContent = lastPanelText;
  }

  if (recorder.active) {
    recorder.push(labelInput.value, [
      res.faceLandmarks.length, fps,
      R.dx, R.dy, R.openness, R.irisDiamPx,
      L.dx, L.dy, L.openness, L.irisDiamPx,
      pose?.yaw ?? NaN, pose?.pitch ?? NaN, pose?.roll ?? NaN, pose?.tz ?? NaN,
      ...m1.csv,
    ]);
    recInfo.textContent = `${t.recording}: ${recorder.count}, ${t.remaining} ${Math.max(0, Math.ceil((recEnd - performance.now()) / 1000))}`;
  }
}
