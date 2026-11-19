// Чистые функции без привязки к интерфейсу (под модульные тесты в M1).
export interface P {
  x: number;
  y: number;
  z: number;
}
export type EyeSide = 'right' | 'left'; // сторона человека; правый глаз виден слева в немиррорированном кадре

// Индексы 478-точечной модели MediaPipe.
export const EYE_IDX = {
  right: { outer: 33, inner: 133, upper: 159, lower: 145, iris: [468, 469, 470, 471, 472] },
  left: { outer: 263, inner: 362, upper: 386, lower: 374, iris: [473, 474, 475, 476, 477] },
} as const;

export interface EyeRaw {
  irisCenterPx: { x: number; y: number };
  irisDiamPx: number;
  eyeWidthPx: number;
  openness: number; // высота/ширина глаза
  /** Смещение центра радужки от середины уголков, в диаметрах радужки. dx > 0 к носу, dy > 0 вверх. */
  dx: number;
  dy: number;
  dxMm: number;
  dyMm: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function measureEye(lm: P[], w: number, h: number, side: EyeSide, irisMm = 11.7): EyeRaw {
  const ix = EYE_IDX[side];
  const px = (i: number) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const outer = px(ix.outer);
  const inner = px(ix.inner);
  const up = px(ix.upper);
  const low = px(ix.lower);
  const c = px(ix.iris[0]);
  const ring = ix.iris.slice(1).map(px);
  const irisDiamPx = (ring.reduce((s, p) => s + dist(c, p), 0) / ring.length) * 2;

  const eyeWidthPx = dist(outer, inner);
  const mid = { x: (outer.x + inner.x) / 2, y: (outer.y + inner.y) / 2 };
  const u = { x: (inner.x - outer.x) / eyeWidthPx, y: (inner.y - outer.y) / eyeWidthPx }; // к носу
  let v = { x: u.y, y: -u.x };
  if (v.y > 0) v = { x: -v.x, y: -v.y }; // «вверх» в кадре (y вниз)

  const d = { x: c.x - mid.x, y: c.y - mid.y };
  const dx = (d.x * u.x + d.y * u.y) / irisDiamPx;
  const dy = (d.x * v.x + d.y * v.y) / irisDiamPx;
  return {
    irisCenterPx: c,
    irisDiamPx,
    eyeWidthPx,
    openness: dist(up, low) / eyeWidthPx,
    dx,
    dy,
    dxMm: dx * irisMm,
    dyMm: dy * irisMm,
  };
}

/** Грубые углы головы из матрицы MediaPipe (column-major 4×4), градусы. Знаки условны, для отладки. */
export function poseFromMatrix(m: ArrayLike<number>): { yaw: number; pitch: number; roll: number; tx: number; ty: number; tz: number } {
  const deg = 180 / Math.PI;
  const yaw = Math.asin(Math.max(-1, Math.min(1, m[8]))) * deg;
  const pitch = Math.atan2(-m[9], m[10]) * deg;
  const roll = Math.atan2(-m[4], m[0]) * deg;
  return { yaw, pitch, roll, tx: m[12], ty: m[13], tz: m[14] };
}

export function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

export function std(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
