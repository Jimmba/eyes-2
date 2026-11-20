// Общее состояние калибровки и поток результатов по кадрам.
import type { FaceModel, LM } from './core/faceModel';
import type { M3, V3 } from './core/linalg';
import { ScaleMethod, ScaleSetup, defaultScale } from './core/scale';
import { clearStored, loadStored, modelToRec, recToModel, saveStored } from './profile';

export interface ZeroRec {
  R: number; // угол правого глаза к носу, °
  L: number;
  z: number; // дистанция, мм
  ipd: number; // межуголковое расстояние, мм
  irisMm: number; // размер радужки, при котором снят ноль
  at: number;
}

/** Результат обработки одного кадра: то, что нужно мастеру калибровки. */
export interface FrameInfo {
  t: number;
  face: boolean;
  w: number;
  h: number;
  lm?: LM[];
  Rraw?: M3 | null;
  irisPx: number;
  open: number;
  angR: number;
  angL: number;
  z: number;
  ipd: number;
  sIris: number; // мм/px по текущему размеру радужки
  f: number; // фокусное расстояние, px
}

export const app = {
  iris: defaultScale() as ScaleSetup,
  irisAt: 0,
  model: null as FaceModel | null,
  modelIrisMm: 0,
  modelCamera: '',
  modelAt: 0,
  zero: null as ZeroRec | null,
  fovDeg: 63,
  cameraKey: '',
  sinks: new Set<(i: FrameInfo) => void>(),
};

export function publish(info: FrameInfo): void {
  for (const s of app.sinks) s(info);
}

/** Модель, пересчитанная под текущий размер радужки (мм линейно зависят от неё). */
export function effectiveModel(): FaceModel | null {
  if (!app.model) return null;
  const k = app.iris.irisMm / app.modelIrisMm;
  if (Math.abs(k - 1) < 1e-9) return app.model;
  return { ...app.model, points: app.model.points.map((p): V3 => [p[0] * k, p[1] * k, p[2] * k]) };
}

export const zeroValid = (): boolean => !!app.zero && Math.abs(app.zero.irisMm - app.iris.irisMm) < 1e-6;

export function persist(): void {
  saveStored({
    v: 1,
    iris: app.irisAt ? { mm: app.iris.irisMm, method: app.iris.method, at: app.irisAt } : undefined,
    model: app.model ? modelToRec(app.model, app.modelIrisMm, app.modelCamera, app.modelAt) : undefined,
  });
}

export function applyIris(mm: number, method: ScaleMethod): void {
  app.iris = { method, irisMm: mm };
  app.irisAt = Date.now();
  if (app.zero && Math.abs(app.zero.irisMm - mm) > 1e-6) app.zero = null; // ноль снимался при другом масштабе
  persist();
}

export function applyModel(m: FaceModel): void {
  app.model = m;
  app.modelIrisMm = app.iris.irisMm;
  app.modelCamera = app.cameraKey;
  app.modelAt = Date.now();
  persist();
}

export function restore(): void {
  const s = loadStored();
  if (s.iris) {
    app.iris = { method: s.iris.method, irisMm: s.iris.mm };
    app.irisAt = s.iris.at;
  }
  if (s.model) {
    app.model = recToModel(s.model);
    app.modelIrisMm = s.model.builtForIrisMm;
    app.modelCamera = s.model.cameraKey;
    app.modelAt = s.model.at;
  }
}

export function resetAll(): void {
  clearStored();
  app.iris = defaultScale();
  app.irisAt = 0;
  app.model = null;
  app.modelAt = 0;
  app.zero = null;
}
