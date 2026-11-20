// Личная метрическая модель лица (план 4.2–4.3): жёсткие точки в мм в системе головы,
// поза (по матрице MediaPipe) и масштаб кадра по этой модели.
import { C, M3, V3, mm, mv, rToEuler, sub, tr } from './linalg';

export interface LM {
  x: number;
  y: number;
  z: number;
}

/** Жёсткие точки (переносица, нос, скулы, контур, подбородок, лоб). Без рта и бровей. Стартовый набор. */
export const RIGID_IDX = [
  168, 6, 197, 195, 5, 4, 1, 193, 417, 151, 9, 234, 454, 127, 356, 93, 323, 132, 361, 152, 175,
] as const;

/**
 * Нормализованные точки → мм в системе камеры «x вправо, y вниз, z от камеры», начало в центре кадра.
 * s = мм на пиксель в плоскости лица; z MediaPipe измеряется в масштабе x (ширины кадра).
 * Если задано фокусное расстояние f (px), учитывается перспектива: ближние к камере точки имеют меньший
 * локальный масштаб (s + z/f). Без f работает слабая перспектива, и у глаз вне оси появляется
 * смещение радужки относительно уголков (параллакс), зависящее от дистанции.
 */
export function toMm(lm: LM[], idx: readonly number[], w: number, h: number, s: number, f?: number): V3[] {
  return idx.map((i): V3 => {
    const z = lm[i].z * w * s;
    const k = f ? s + z / f : s;
    return [(lm[i].x * w - w / 2) * k, (lm[i].y * h - h / 2) * k, z];
  });
}

/**
 * Матрица позы MediaPipe может трактоваться по-разному (OpenGL-оси, прямой/обратный поворот).
 * Конвенцию выбирает сама модель: правильная даёт наименьший разброс точек в системе головы.
 */
export const CONVENTIONS: { id: string; apply: (R: M3) => M3 }[] = [
  { id: 'C·R·C', apply: (R) => mm(mm(C, R), C) },
  { id: 'C·Rᵀ·C', apply: (R) => mm(mm(C, tr(R)), C) },
  { id: 'R', apply: (R) => R },
  { id: 'Rᵀ', apply: (R) => tr(R) },
];
export const conventionById = (id: string) => CONVENTIONS.find((c) => c.id === id) ?? CONVENTIONS[0];

export function centroid(p: V3[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const q of p) {
    c[0] += q[0];
    c[1] += q[1];
    c[2] += q[2];
  }
  return [c[0] / p.length, c[1] / p.length, c[2] / p.length];
}

export interface FaceModel {
  points: V3[]; // система головы, начало в центре жёстких точек, мм
  convention: string;
  spreadMm: number; // СКО точек по кадрам у выбранной конвенции
  allSpreads: Record<string, number>;
  frames: number;
  yawRangeDeg: number;
  pitchRangeDeg: number;
  /** Поворотов по обеим осям меньше ~6°: конвенция выбрана ненадёжно, нужно подвигать головой. */
  poseVariationOk: boolean;
}

export class FaceModelBuilder {
  private frames: { pts: V3[]; R: M3 }[] = [];
  constructor(private maxFrames = 400) {}

  get count(): number {
    return this.frames.length;
  }
  reset(): void {
    this.frames = [];
  }
  add(pts: V3[], Rraw: M3): void {
    if (this.frames.length < this.maxFrames) this.frames.push({ pts, R: Rraw });
  }

  build(minFrames = 20): FaceModel | null {
    if (this.frames.length < minFrames) return null;
    const n = this.frames[0].pts.length;
    let best: { id: string; model: V3[]; spread: number } | null = null;
    const all: Record<string, number> = {};
    for (const conv of CONVENTIONS) {
      const per = this.frames.map(({ pts, R }) => {
        const Rt = tr(conv.apply(R));
        const c = centroid(pts);
        return pts.map((p) => mv(Rt, sub(p, c)));
      });
      const model: V3[] = [];
      for (let i = 0; i < n; i++) {
        let sx = 0, sy = 0, sz = 0;
        for (const f of per) {
          sx += f[i][0];
          sy += f[i][1];
          sz += f[i][2];
        }
        model.push([sx / per.length, sy / per.length, sz / per.length]);
      }
      let ss = 0;
      for (const f of per) for (let i = 0; i < n; i++) ss += (f[i][0] - model[i][0]) ** 2 + (f[i][1] - model[i][1]) ** 2 + (f[i][2] - model[i][2]) ** 2;
      const spread = Math.sqrt(ss / (per.length * n));
      all[conv.id] = spread;
      if (!best || spread < best.spread) best = { id: conv.id, model, spread };
    }
    const chosen = conventionById(best!.id);
    let y0 = Infinity, y1 = -Infinity, p0 = Infinity, p1 = -Infinity;
    for (const { R } of this.frames) {
      const e = rToEuler(chosen.apply(R));
      y0 = Math.min(y0, e.yaw); y1 = Math.max(y1, e.yaw);
      p0 = Math.min(p0, e.pitch); p1 = Math.max(p1, e.pitch);
    }
    return {
      points: best!.model,
      convention: best!.id,
      spreadMm: best!.spread,
      allSpreads: all,
      frames: this.frames.length,
      yawRangeDeg: y1 - y0,
      pitchRangeDeg: p1 - p0,
      poseVariationOk: y1 - y0 >= 6 && p1 - p0 >= 6,
    };
  }
}

export interface CamIntrinsics {
  f: number; // фокусное расстояние, px
  cx: number; // центр кадра, px
  cy: number;
}

/**
 * Масштаб кадра по модели: мм на пиксель в плоскости лица, s = Z/f.
 * Без cam: слабая перспектива (сравнение размахов проекции и пикселей).
 * С cam: перспективная подгонка. Модель поворачивается позой Rimg, ищется расстояние Z (поиск «золотым сечением»),
 * при котором проекция модели лучше всего совпала с пикселями; сдвиг по x и y подбирается для каждого Z.
 */
export function fitScale(model: V3[], Rimg: M3, ptsPx: { x: number; y: number }[], cam?: CamIntrinsics): { mmPerPx: number; residualPx: number } {
  const q = model.map((m) => mv(Rimg, m));
  if (!cam) return fitScaleWeak(q, ptsPx);
  const a = ptsPx.map((p) => [p.x - cam.cx, p.y - cam.cy]);
  const resid = (Z: number): { r: number } => {
    let tx = 0, ty = 0;
    for (let i = 0; i < q.length; i++) {
      tx += (a[i][0] * (Z + q[i][2])) / cam.f - q[i][0];
      ty += (a[i][1] * (Z + q[i][2])) / cam.f - q[i][1];
    }
    tx /= q.length;
    ty /= q.length;
    let r = 0;
    for (let i = 0; i < q.length; i++) {
      const u = (cam.f * (tx + q[i][0])) / (Z + q[i][2]);
      const v = (cam.f * (ty + q[i][1])) / (Z + q[i][2]);
      r += (u - a[i][0]) ** 2 + (v - a[i][1]) ** 2;
    }
    return { r: Math.sqrt(r / q.length) };
  };
  let lo = 100, hi = 3000;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
  let f1 = resid(x1).r, f2 = resid(x2).r;
  for (let it = 0; it < 60; it++) {
    if (f1 < f2) {
      hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = resid(x1).r;
    } else {
      lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = resid(x2).r;
    }
  }
  const Z = (lo + hi) / 2;
  return { mmPerPx: Z / cam.f, residualPx: resid(Z).r };
}

function fitScaleWeak(q: V3[], ptsPx: { x: number; y: number }[]): { mmPerPx: number; residualPx: number } {
  const mq = [q.reduce((a, v) => a + v[0], 0) / q.length, q.reduce((a, v) => a + v[1], 0) / q.length];
  const mp = [ptsPx.reduce((a, v) => a + v.x, 0) / ptsPx.length, ptsPx.reduce((a, v) => a + v.y, 0) / ptsPx.length];
  let sq = 0, sp = 0;
  const qc = q.map((v) => [v[0] - mq[0], v[1] - mq[1]]);
  const pc = ptsPx.map((v) => [v.x - mp[0], v.y - mp[1]]);
  for (let i = 0; i < q.length; i++) {
    sq += qc[i][0] ** 2 + qc[i][1] ** 2;
    sp += pc[i][0] ** 2 + pc[i][1] ** 2;
  }
  const s = Math.sqrt(sq / sp);
  let r = 0;
  for (let i = 0; i < q.length; i++) r += (qc[i][0] / s - pc[i][0]) ** 2 + (qc[i][1] / s - pc[i][1]) ** 2;
  return { mmPerPx: s, residualPx: Math.sqrt(r / q.length) };
}
