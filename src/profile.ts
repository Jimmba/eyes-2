// Интерим-хранилище калибровки (до M4, где всё переедет в IndexedDB): размер радужки и модель лица.
// Личный ноль здесь не хранится: он действует только в текущей сессии.
import type { FaceModel } from './core/faceModel';
import type { ScaleMethod } from './core/scale';

const KEY = 'strab.calibration.v1';

export interface IrisRec {
  mm: number;
  method: ScaleMethod;
  at: number;
}
export interface ModelRec {
  points: [number, number, number][];
  convention: string;
  spreadMm: number;
  frames: number;
  yawRangeDeg: number;
  pitchRangeDeg: number;
  builtForIrisMm: number; // размер радужки, при котором модель построена (при смене радужки масштабируется)
  builtFovDeg?: number; // поле зрения камеры, при котором модель построена
  cameraKey: string;
  at: number;
}
export interface GainsRec {
  R: { h: number; v: number };
  L: { h: number; v: number };
  at: number;
  fovAtFit?: number; // поле зрения камеры, при котором подобраны коэффициенты
  info?: string;
}
export interface ScreenRec {
  mmPerCssPx: number;
  dpr: number; // при смене масштаба браузера размер CSS-пикселя меняется: калибровку нужно повторить
  method: 'card' | 'diagonal';
  at: number;
}
export interface Stored {
  v: 1;
  iris?: IrisRec;
  model?: ModelRec;
  camera?: Record<string, number>; // поле зрения по вертикали (°): ключ «камера|ширина×высота»
  gains?: Record<string, GainsRec>; // ключ: камера
  screen?: ScreenRec;
  ack?: number; // время подтверждения предупреждения о противопоказаниях
}

export function loadStored(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.v === 1 ? (s as Stored) : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

export function saveStored(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* хранилище недоступно: калибровка живёт до закрытия страницы */
  }
}

export function clearStored(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const modelToRec = (m: FaceModel, builtForIrisMm: number, cameraKey: string, at: number, builtFovDeg: number): ModelRec => ({
  points: m.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
  convention: m.convention,
  spreadMm: m.spreadMm,
  frames: m.frames,
  yawRangeDeg: m.yawRangeDeg,
  pitchRangeDeg: m.pitchRangeDeg,
  builtForIrisMm,
  builtFovDeg,
  cameraKey,
  at,
});

export const recToModel = (r: ModelRec): FaceModel => ({
  points: r.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
  convention: r.convention,
  spreadMm: r.spreadMm,
  allSpreads: {},
  frames: r.frames,
  yawRangeDeg: r.yawRangeDeg,
  pitchRangeDeg: r.pitchRangeDeg,
  poseVariationOk: r.yawRangeDeg >= 6 && r.pitchRangeDeg >= 6,
});
