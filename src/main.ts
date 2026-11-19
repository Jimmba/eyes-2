import { DrawingUtils, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { onVideoFrame, startCamera, type CameraHandle } from './camera';
import { state } from './config';
import { measureEye, median, poseFromMatrix, std, type EyeRaw, type EyeSide } from './geometry';
import { t } from './i18n';
import { Recorder } from './recorder';
import { saveSnapshot } from './snapshot';
import { createLandmarker, type Landmarker } from './vision';

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
    recorder.push(labelInput.value, [0, fps, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
    return;
  }
  const lm = res.faceLandmarks[i];
  const R = measureEye(lm, w, h, 'right'); // пиксели полного кадра
  const L = measureEye(lm, w, h, 'left');
  push('right', R);
  push('left', L);

  const pose = res.facialTransformationMatrixes?.[i]
    ? poseFromMatrix(res.facialTransformationMatrixes[i].data)
    : null;

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
    ]);
    recInfo.textContent = `${t.recording}: ${recorder.count}, ${t.remaining} ${Math.max(0, Math.ceil((recEnd - performance.now()) / 1000))}`;
  }
}
