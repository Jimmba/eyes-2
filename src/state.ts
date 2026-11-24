// Общее состояние калибровки и поток результатов по кадрам.
import type { FaceModel, LM } from './core/faceModel';
import type { M3, V3 } from './core/linalg';
import { ScaleMethod, ScaleSetup, defaultScale } from './core/scale';
import { ExPrefs, GainsRec, HistRec, ScreenRec, clearStored, loadStored, modelToRec, recToModel, saveStored } from './profile';

export interface ZeroRec {
  R: number; // угол правого глаза к носу, °
  L: number;
  z: number; // дистанция, мм
  ipd: number; // межуголковое расстояние, мм
  irisMm: number; // размер радужки, при котором снят ноль
  sigma: number; // шум сигнала вергенции в покое (после медианы из 3 кадров), °
  at: number;
}

/** Результат обработки одного кадра: то, что нужно мастерам калибровки и тренировке. */
export interface FrameInfo {
  t: number;
  face: boolean;
  w: number;
  h: number;
  lm?: LM[];
  Rraw?: M3 | null;
  Rimg?: M3 | null;
  irisPx: number;
  open: number; // min(правый, левый)
  openR: number;
  openL: number;
  angR: number; // с учётом коэффициентов глаз
  angL: number;
  rawH: { R: number; L: number }; // горизонтальный угол без коэффициента
  rawV: { R: number; L: number }; // вертикальный угол без коэффициента (вверх > 0)
  eyeCam?: { R: V3; L: V3 }; // центры глазных яблок в системе камеры, мм
  z: number;
  zq: number; // то же, но быстрее (медиана 3 кадров): для подсказок в упражнении
  zs: number; // расстояние, сглажено медианой по последним кадрам, мм (его показываем и пишем в результаты)
  ipd: number;
  sIris: number; // мм/px по текущему размеру радужки
  f: number; // фокусное расстояние, px
  devInst: number; // вергенция от нуля по одному кадру, ° (NaN без нуля)
  valid: boolean; // кадр годен для детектора (лицо, глаза открыты)
}

export type Gains = GainsRec;
export type ScreenCal = ScreenRec;

export const app = {
  iris: defaultScale() as ScaleSetup,
  irisAt: 0,
  model: null as FaceModel | null,
  modelIrisMm: 0,
  modelFov: 63,
  modelCamera: '',
  modelAt: 0,
  zero: null as ZeroRec | null,
  cameraFov: {} as Record<string, number>,
  distK: {} as Record<string, number>,
  history: [] as HistRec[],
  ex: { size: 'medium', dyn: false } as ExPrefs,
  gains: null as Gains | null,
  gainsAll: {} as Record<string, Gains>,
  screen: null as ScreenCal | null,
  direction: 'away' as 'away' | 'closer',
  ack: 0,
  cameraKey: '',
  lastInfo: null as FrameInfo | null,
  pendingEvent: '',
  /** Пометки для журнала CSV: user = 1, пока пользователь держит касание (есть срыв); det = 1, пока детектор камеры считает, что срыв. */
  annot: { user: 0, det: 0 },
  sinks: new Set<(i: FrameInfo) => void>(),
};

export function publish(info: FrameInfo): void {
  app.lastInfo = info;
  for (const s of app.sinks) s(info);
}

export const DEFAULT_FOV = 63;
export const fovKey = (w: number, h: number): string => `${app.cameraKey}|${w}x${h}`;
export const currentFov = (w: number, h: number): number => app.cameraFov[fovKey(w, h)] ?? DEFAULT_FOV;
export const fovCalibrated = (w: number, h: number): boolean => fovKey(w, h) in app.cameraFov;
export function setFov(w: number, h: number, deg: number): void {
  app.cameraFov[fovKey(w, h)] = deg;
  persist();
}

export const currentDistK = (w: number, h: number): number => app.distK[fovKey(w, h)] ?? 1;
export function setDistK(w: number, h: number, k: number): void {
  app.distK[fovKey(w, h)] = k;
  persist();
}
export function addHistory(r: HistRec): void {
  app.history.push(r);
  if (app.history.length > 200) app.history.splice(0, app.history.length - 200);
  persist();
}
/** Прошлый итог того же вида и направления (для сравнения «было → стало»). */
export const lastHistory = (kinds: HistRec['kind'][], direction: 'away' | 'closer'): HistRec | undefined =>
  [...app.history].reverse().find((r) => kinds.includes(r.kind) && r.direction === direction && (Number.isFinite(r.boundaryCm) || Number.isFinite(r.holdCm ?? NaN)));

export function setGains(g: Gains): void {
  app.gains = g;
  app.gainsAll[app.cameraKey] = g;
  persist();
}
export const loadGainsForCamera = (): void => {
  app.gains = app.gainsAll[app.cameraKey] ?? null;
};

export const screenValid = (): boolean => !!app.screen && Math.abs(app.screen.dpr - window.devicePixelRatio) < 0.01;

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
    model: app.model ? modelToRec(app.model, app.modelIrisMm, app.modelCamera, app.modelAt, app.modelFov) : undefined,
    camera: Object.keys(app.cameraFov).length ? app.cameraFov : undefined,
    distK: Object.keys(app.distK).length ? app.distK : undefined,
    history: app.history.length ? app.history : undefined,
    ex: app.ex,
    gains: Object.keys(app.gainsAll).length ? app.gainsAll : undefined,
    screen: app.screen ?? undefined,
    ack: app.ack || undefined,
  });
}

export function applyIris(mm: number, method: ScaleMethod): void {
  app.iris = { method, irisMm: mm };
  app.irisAt = Date.now();
  if (app.zero && Math.abs(app.zero.irisMm - mm) > 1e-6) app.zero = null; // ноль снимался при другом масштабе
  persist();
}

export function applyModel(m: FaceModel, fovDeg = DEFAULT_FOV): void {
  app.model = m;
  app.modelFov = fovDeg;
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
    app.modelFov = s.model.builtFovDeg ?? DEFAULT_FOV;
    app.modelCamera = s.model.cameraKey;
    app.modelAt = s.model.at;
  }
  app.cameraFov = s.camera ?? {};
  app.distK = s.distK ?? {};
  app.history = s.history ?? [];
  app.ex = s.ex ?? { size: 'medium', dyn: false };
  app.gainsAll = s.gains ?? {};
  app.screen = s.screen ?? null;
  app.ack = s.ack ?? 0;
}

export function resetAll(): void {
  clearStored();
  app.iris = defaultScale();
  app.irisAt = 0;
  app.model = null;
  app.modelAt = 0;
  app.zero = null;
  app.cameraFov = {};
  app.distK = {};
  app.history = [];
  app.gains = null;
  app.gainsAll = {};
  app.screen = null;
  app.ack = 0;
}
