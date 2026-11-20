// Минимальная линейная алгебра 3D (без зависимостей). Матрицы 3×3 хранятся построчно.
export type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => mul(a, 1 / norm(a));

export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Поворот на π вокруг X: переводит систему «y вверх, z к зрителю» (OpenGL, MediaPipe) в «y вниз, z от камеры» (изображение). */
export const C: M3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export const mv = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export function mm(a: M3, b: M3): M3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r as M3;
}

export const tr = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export const rotX = (a: number): M3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
export const rotY = (a: number): M3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
export const rotZ = (a: number): M3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
export const toRad = (d: number) => d * RAD;
export const toDeg = (r: number) => r * DEG;

/** R = Ry(yaw)·Rx(pitch)·Rz(roll), углы в градусах. */
export const eulerToR = (yawDeg: number, pitchDeg: number, rollDeg: number): M3 =>
  mm(mm(rotY(yawDeg * RAD), rotX(pitchDeg * RAD)), rotZ(rollDeg * RAD));

export function rToEuler(R: M3): { yaw: number; pitch: number; roll: number } {
  return {
    yaw: Math.atan2(R[2], R[8]) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, -R[5]))) * DEG,
    roll: Math.atan2(R[3], R[4]) * DEG,
  };
}

/** Матрица позы MediaPipe (4×4, по столбцам) → чистый поворот 3×3 (масштаб убран нормировкой столбцов). */
export function mpMatrixToR(m: ArrayLike<number>): M3 {
  const col = (c: number): V3 => unit([m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]);
  const [a, b, c] = [col(0), col(1), col(2)];
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}
