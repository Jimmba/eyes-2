// Синтетическая модель лица: известная геометрия, известные углы глаз и позы, камера-«точечное отверстие».
import { C, M3, V3, add, cross, eulerToR, mm, mv, mul, sub, tr, unit } from '../src/core/linalg';
import { RIGID_IDX, LM } from '../src/core/faceModel';
import { EYE } from '../src/core/gaze';

// Жёсткие точки в системе головы, мм: x вправо (в кадре), y вниз, z от камеры (нос выступает, z < 0).
const RIGID_XYZ: Record<number, V3> = {
  168: [0, -5, -8], 6: [0, -2, -12], 197: [0, 10, -18], 195: [0, 20, -22], 5: [0, 30, -24], 4: [0, 35, -28], 1: [0, 38, -26],
  193: [-12, -3, -4], 417: [12, -3, -4], 151: [0, -45, -4], 9: [0, -35, -8],
  234: [-68, 5, 30], 454: [68, 5, 30], 127: [-65, -15, 28], 356: [65, -15, 28],
  93: [-62, 30, 32], 323: [62, 30, 32], 132: [-55, 50, 30], 361: [55, 50, 30], 152: [0, 70, -2], 175: [0, 62, -10],
};
export const EYE_R = 12; // радиус глазного яблока, мм
export const IRIS_MM = 11.7;
const HALF_IPD = 31; // половина расстояния между центрами глазных яблок
const EYE_CENTER: Record<'right' | 'left', V3> = { right: [-HALF_IPD, -5, 10], left: [HALF_IPD, -5, 10] };
const CORNER_DX = 11; // уголки глаза по обе стороны от центра яблока вдоль x

export interface Cam {
  w: number;
  h: number;
  f: number;
}
export const CAM: Cam = { w: 1080, h: 1920, f: 960 / Math.tan((63 * Math.PI) / 360) };

export interface Gaze {
  right: { nasal: number; up?: number }; // градусы, к носу > 0, вверх > 0
  left: { nasal: number; up?: number };
}

export interface Pose {
  yaw: number;
  pitch: number;
  roll: number;
  zMm: number;
  tx?: number;
  ty?: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

function headPoints(g: Gaze): Map<number, V3> {
  const pts = new Map<number, V3>();
  for (const i of RIGID_IDX) pts.set(i, RIGID_XYZ[i]);
  for (const side of ['right', 'left'] as const) {
    const E = EYE_CENTER[side];
    const sgn = side === 'right' ? 1 : -1; // направление «к носу» вдоль +x для правого глаза
    const a = rad(g[side].nasal) * sgn;
    const e = rad(g[side].up ?? 0);
    const gaze: V3 = [Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e)];
    const zc = -Math.sqrt(EYE_R ** 2 - CORNER_DX ** 2);
    pts.set(EYE[side].outer, add(E, [-sgn * CORNER_DX, 0, zc]));
    pts.set(EYE[side].inner, add(E, [sgn * CORNER_DX, 0, zc]));
    const center = add(E, mul(gaze, EYE_R));
    pts.set(EYE[side].iris[0], center);
    const t1 = unit(cross(gaze, [0, 1, 0]));
    const t2 = cross(gaze, t1);
    for (let k = 0; k < 4; k++) {
      const al = (k * Math.PI) / 2;
      pts.set(EYE[side].iris[k + 1], add(center, add(mul(t1, (IRIS_MM / 2) * Math.cos(al)), mul(t2, (IRIS_MM / 2) * Math.sin(al)))));
    }
  }
  return pts;
}

export interface Frame {
  lm: LM[];
  Rimg: M3;
  /** то, что дал бы MediaPipe в данной конвенции */
  Rraw: (conv: 'C·R·C' | 'C·Rᵀ·C' | 'R' | 'Rᵀ') => M3;
  s: number; // истинные мм на пиксель в плоскости лица
}

export function render(g: Gaze, p: Pose, noisePx = 0, rnd: () => number = Math.random, cam: Cam = CAM, zNoiseMm = 0): Frame {
  const Rimg = eulerToR(p.yaw, p.pitch, p.roll);
  const T: V3 = [p.tx ?? 0, p.ty ?? 0, p.zMm];
  const s = p.zMm / cam.f;
  const lm: LM[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  for (const [i, hp] of headPoints(g)) {
    const c = add(mv(Rimg, hp), T);
    const u = cam.w / 2 + (cam.f * c[0]) / c[2] + noisePx * gauss();
    const v = cam.h / 2 + (cam.f * c[1]) / c[2] + noisePx * gauss();
    lm[i] = { x: u / cam.w, y: v / cam.h, z: (c[2] - p.zMm + zNoiseMm * gauss()) / (cam.w * s) };
  }
  const raw = {
    'C·R·C': mm(mm(C, Rimg), C),
    'C·Rᵀ·C': tr(mm(mm(C, Rimg), C)),
    R: Rimg,
    'Rᵀ': tr(Rimg),
  };
  return { lm, Rimg, Rraw: (c) => raw[c], s };
}

/** Детерминированный генератор (mulberry32), чтобы тесты были воспроизводимы. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fixate = (z: number, ipd = 2 * HALF_IPD): Gaze => {
  const n = (Math.atan(ipd / 2 / z) * 180) / Math.PI;
  return { right: { nasal: n }, left: { nasal: n } };
};
export { RIGID_XYZ, HALF_IPD, sub };
