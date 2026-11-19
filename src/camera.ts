// Камера: getUserMedia 1920×1080 @30, фронтальная. Кадры считаем немиррорированными.
export interface CameraHandle {
  stream: MediaStream;
  info: string;
  stop(): void;
}

export async function startCamera(video: HTMLVideoElement, size = { w: 1920, h: 1080 }): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia недоступен');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: size.w },
      height: { ideal: size.h },
      frameRate: { ideal: 30 },
    },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  const track = stream.getVideoTracks()[0];
  const s = track.getSettings();
  const handle: CameraHandle = {
    stream,
    info: `${s.width}×${s.height} @${s.frameRate ?? '?'} fps`,
    stop: () => stream.getTracks().forEach((tr) => tr.stop()),
  };
  // Даём автофокусу и экспозиции установиться, затем замораживаем (где позволяет API).
  setTimeout(() => void freezeAuto(track, handle), 2000);
  return handle;
}

async function freezeAuto(track: MediaStreamTrack, handle: CameraHandle): Promise<void> {
  try {
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const adv: Record<string, unknown> = {};
    const has = (k: string, v: string) => Array.isArray(caps[k]) && (caps[k] as string[]).includes(v);
    if (has('focusMode', 'manual')) adv.focusMode = 'manual';
    if (has('exposureMode', 'manual')) adv.exposureMode = 'manual';
    if (has('whiteBalanceMode', 'manual')) adv.whiteBalanceMode = 'manual';
    if (Object.keys(adv).length === 0) return;
    await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
    handle.info += ` | заморожено: ${Object.keys(adv).join(', ')}`;
  } catch (e) {
    console.warn('Не удалось заморозить автонастройки камеры', e);
  }
}

/** Цикл по кадрам видео (requestVideoFrameCallback, запасной вариант rAF). Возвращает функцию остановки. */
export function onVideoFrame(video: HTMLVideoElement, cb: (nowMs: number) => void): () => void {
  let stopped = false;
  let last = 0;
  const tick = (now: number) => {
    if (stopped) return;
    if (now <= last) now = last + 1; // метки времени для MediaPipe строго возрастают
    last = now;
    try {
      cb(now);
    } catch (e) {
      console.error(e);
    }
    schedule();
  };
  const schedule = () => {
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback((now) => tick(now));
    else requestAnimationFrame(tick);
  };
  schedule();
  return () => {
    stopped = true;
  };
}
