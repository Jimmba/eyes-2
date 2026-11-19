import { DrawingUtils, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { onVideoFrame, startCamera, type CameraHandle } from './camera';
import { state } from './config';
import { measureEye, median, poseFromMatrix, std, type EyeRaw, type EyeSide } from './geometry';
import { t } from './i18n';
import { Recorder } from './recorder';
import { createLandmarker, type Landmarker } from './vision';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const panel = $<HTMLPreElement>('panel');
const statusEl = $('status');
const startBtn = $<HTMLButtonElement>('start');
const devBox = $<HTMLInputElement>('dev');
const recBtn = $<HTMLButtonElement>('rec');
const labelInput = $<HTMLInputElement>('label');
const recInfo = $('recInfo');
const cropCanvas: Record<EyeSide, HTMLCanvasElement> = { right: $('cropR'), left: $('cropL') };

// i18n
$('title').textContent = t.title;
$('disclaimer').textContent = t.disclaimer;
startBtn.textContent = t.start;
$('devLabel').textContent = t.dev;
recBtn.textContent = t.record;
labelInput.placeholder = t.labelPlaceholder;
recInfo.textContent = t.recHint;
$('capR').textContent = t.eyeR;
$('capL').textContent = t.eyeL;

const recorder = new Recorder();
const WINDOW = 30; // кадров в окне статистики (~1 с)
const hist: Record<EyeSide, { dx: number[]; dy: number[] }> = {
  right: { dx: [], dy: [] },
  left: { dx: [], dy: [] },
};
let fps = 0;
let lastNow = 0;
let cam: CameraHandle | null = null;
let engine: Landmarker | null = null;
let stopLoop: (() => void) | null = null;

devBox.addEventListener('change', () => {
  state.isDev = devBox.checked;
});

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  statusEl.textContent = t.starting;
  try {
    if (!window.isSecureContext) throw new Error(t.noHttps);
    cam = await startCamera(video);
    engine = await createLandmarker();
    statusEl.textContent = `${t.running}: ${cam.info}; ${engine.delegate}`;
    recBtn.disabled = false;
    stopLoop = onVideoFrame(video, processFrame);
  } catch (e) {
    console.error(e);
    statusEl.textContent = `${t.error}: ${(e as Error).message}`;
    startBtn.disabled = false;
    stopLoop?.();
    cam?.stop();
  }
});

recBtn.addEventListener('click', () => {
  if (recorder.active) {
    recorder.stopAndDownload();
    recBtn.textContent = t.record;
    recInfo.textContent = t.recHint;
  } else {
    recorder.start();
    recBtn.textContent = t.recordStop;
  }
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
  const cx = e.irisCenterPx.x;
  const cy = e.irisCenterPx.y;
  const sw = e.eyeWidthPx * 2.2;
  const sh = sw / 2;
  g.drawImage(video, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, c.width, c.height);
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

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (view.width !== w || view.height !== h) {
    view.width = w;
    view.height = h;
  }
  ctx.drawImage(video, 0, 0, w, h);

  const res = engine.lm.detectForVideo(video, now);
  const i = pickFace(res);
  if (i < 0) {
    panel.textContent = `${t.noFace}\nfps ${fps.toFixed(1)}`;
    recorder.push(labelInput.value, [0, fps, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
    return;
  }
  const lm = res.faceLandmarks[i];
  const R = measureEye(lm, w, h, 'right');
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
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(e.irisCenterPx.x - 8, e.irisCenterPx.y);
      ctx.lineTo(e.irisCenterPx.x + 8, e.irisCenterPx.y);
      ctx.moveTo(e.irisCenterPx.x, e.irisCenterPx.y - 8);
      ctx.lineTo(e.irisCenterPx.x, e.irisCenterPx.y + 8);
      ctx.stroke();
    }
    drawCrop('right', R);
    drawCrop('left', L);

    const blink = res.faceBlendshapes?.[i]?.categories ?? [];
    const bl = (n: string) => blink.find((c) => c.categoryName === n)?.score ?? NaN;
    const vergence = R.dx - L.dx; // обе величины «к носу > 0»
    panel.textContent = [
      `лиц: ${res.faceLandmarks.length}  fps ${fps.toFixed(1)}  кадр ${w}×${h}`,
      eyeLines('ПРАВЫЙ (R)', 'right', R),
      eyeLines('ЛЕВЫЙ  (L)', 'left', L),
      `R.dx − L.dx = ${f(vergence)} (диам. радужки)`,
      pose
        ? `поза: yaw ${f(pose.yaw, 1)} pitch ${f(pose.pitch, 1)} roll ${f(pose.roll, 1)}  tz ${f(pose.tz, 1)}`
        : 'поза: нет матрицы',
      `моргание (blendshape): Left ${f(bl('eyeBlinkLeft'), 2)} Right ${f(bl('eyeBlinkRight'), 2)}`,
    ].join('\n');
  } else {
    panel.textContent = `fps ${fps.toFixed(1)}`;
  }

  if (recorder.active) {
    recorder.push(labelInput.value, [
      res.faceLandmarks.length, fps,
      R.dx, R.dy, R.openness, R.irisDiamPx,
      L.dx, L.dy, L.openness, L.irisDiamPx,
      pose?.yaw ?? NaN, pose?.pitch ?? NaN, pose?.roll ?? NaN, pose?.tz ?? NaN,
    ]);
    recInfo.textContent = `${t.recording}: ${recorder.count}`;
  }
}
