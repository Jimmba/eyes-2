// Положение радужки → угол глаза → отклонение относительно личного нуля (план 4.3–4.7).
// Соглашения: dx > 0 к носу для обоих глаз, dy > 0 вверх; «правый/левый» по человеку.
import { M3, V3, mv, sub, tr, toDeg, toRad } from './linalg';
import { LM, toMm } from './faceModel';

export type Side = 'right' | 'left';

export const EYE = {
  right: { outer: 33, inner: 133, iris: [468, 469, 470, 471, 472] },
  left: { outer: 263, inner: 362, iris: [473, 474, 475, 476, 477] },
} as const;

export const EYEBALL_RADIUS_MM = 12;

const px = (lm: LM[], i: number, w: number, h: number) => ({ x: lm[i].x * w, y: lm[i].y * h });

/** Диаметр радужки в пикселях: среднее расстояние от центра до 4 точек контура ×2. */
export function irisDiamPx(lm: LM[], w: number, h: number, side: Side): number {
  const ix = EYE[side].iris;
  const c = px(lm, ix[0], w, h);
  let s = 0;
  for (let k = 1; k < 5; k++) {
    const p = px(lm, ix[k], w, h);
    s += Math.hypot(p.x - c.x, p.y - c.y);
  }
  return (s / 4) * 2;
}

/** Расстояние между серединами уголков глаз (мм); не меняется при сведении глаз. */
export function interEyeMm(lm: LM[], w: number, h: number, s: number, f?: number): number {
  const p = toMm(lm, [EYE.right.outer, EYE.right.inner, EYE.left.outer, EYE.left.inner], w, h, s, f);
  const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const d = sub(mid(p[0], p[1]), mid(p[2], p[3]));
  return Math.hypot(d[0], d[1], d[2]);
}

/**
 * Смещение центра радужки от середины уголков, мм (x к носу, y вверх).
 * Если задана поза Rimg, смещение берётся в системе головы (компенсация поворота и наклона, режим 3D);
 * иначе по оси уголков в плоскости кадра (режим 2D, как в M0).
 * f (px) включает перспективную поправку по глубине (см. toMm).
 */
export function eyeOffsetMm(lm: LM[], w: number, h: number, side: Side, s: number, Rimg: M3 | null, f?: number): { dxMm: number; dyMm: number } {
  const e = EYE[side];
  if (Rimg) {
    const [o, i, c] = toMm(lm, [e.outer, e.inner, e.iris[0]], w, h, s, f);
    const mid: V3 = [(o[0] + i[0]) / 2, (o[1] + i[1]) / 2, (o[2] + i[2]) / 2];
    const dh = mv(tr(Rimg), sub(c, mid));
    return { dxMm: (side === 'right' ? 1 : -1) * dh[0], dyMm: -dh[1] };
  }
  const o = px(lm, e.outer, w, h);
  const i = px(lm, e.inner, w, h);
  const c = px(lm, e.iris[0], w, h);
  const len = Math.hypot(i.x - o.x, i.y - o.y);
  const u = { x: (i.x - o.x) / len, y: (i.y - o.y) / len };
  let v = { x: u.y, y: -u.x };
  if (v.y > 0) v = { x: -v.x, y: -v.y };
  const d = { x: c.x - (o.x + i.x) / 2, y: c.y - (o.y + i.y) / 2 };
  return { dxMm: (d.x * u.x + d.y * u.y) * s, dyMm: (d.x * v.x + d.y * v.y) * s };
}

/** Угол глаза из смещения: θ = k·asin(Δ/R); k подгоняется в калибровке (M2), по умолчанию 1. */
export function angleDeg(offMm: number, radiusMm = EYEBALL_RADIUS_MM, k = 1): number {
  return k * toDeg(Math.asin(Math.max(-1, Math.min(1, offMm / radiusMm))));
}

/** Ожидаемый поворот каждого глаза к носу при взгляде на точку на расстоянии zMm. */
export const expectedNasalDeg = (interEyeMm: number, zMm: number): number => toDeg(Math.atan(interEyeMm / 2 / zMm));

/**
 * Отклонение глаза относительно личного нуля. Ноль снят при слиянии на расстоянии zZeroMm;
 * при другой дистанции ожидаемое сведение пересчитывается.
 */
export function deviationDeg(angle: number, zeroAngle: number, zMm: number, zZeroMm: number, interEye: number): number {
  return angle - zeroAngle - (expectedNasalDeg(interEye, zMm) - expectedNasalDeg(interEye, zZeroMm));
}

/** ПД = 100·tg(θ). */
export const prismDiopters = (deg: number): number => 100 * Math.tan(toRad(deg));

/** При dx «к носу > 0»: вергенция = сумма (>0 сведение/эзо, <0 разведение/экзо), версия = полуразность (общий поворот взгляда). */
export const binocular = (devRight: number, devLeft: number) => ({
  vergenceDeg: devRight + devLeft,
  versionDeg: (devRight - devLeft) / 2,
});

/** Середина уголков глаза в системе камеры (мм, z от камеры до точки). Z = f·s: глубина плоскости лица. */
export function cornersMidCam(lm: LM[], w: number, h: number, side: Side, s: number, f: number): V3 {
  const e = EYE[side];
  const [o, i] = toMm(lm, [e.outer, e.inner], w, h, s, f);
  return [(o[0] + i[0]) / 2, (o[1] + i[1]) / 2, f * s + (o[2] + i[2]) / 2];
}
