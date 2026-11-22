// Геометрия «экран → глаз» для калибровки коэффициентов (план M2): истинные углы взгляда на точку экрана.
// Система камеры: x вправо в кадре (влево для пользователя), y вниз, z от камеры к пользователю; экран в плоскости z = 0.
import { M3, V3, add, mv, sub, toDeg, tr } from './linalg';
import type { Side } from './gaze';

export interface ScreenSpec {
  mmPerCssPx: number;
  widthCss: number; // видимая область, CSS px
  heightCss: number;
  camOffsetMm: number; // расстояние от верхнего края области до центра камеры вниз (мм); камера по центру верхнего края
}

/** Центр глазного яблока позади плоскости уголков, мм (стартовое значение). */
export const EYE_BACK_MM = 7;

/** Точка экрана (CSS px от левого верхнего угла области) → мм в системе камеры. */
export function screenToCam(u: number, v: number, s: ScreenSpec): V3 {
  return [-(u - s.widthCss / 2) * s.mmPerCssPx, v * s.mmPerCssPx + s.camOffsetMm, 0];
}

export const eyeCenterCam = (cornersMid: V3, Rimg: M3): V3 => add(cornersMid, mv(Rimg, [0, 0, EYE_BACK_MM]));

/** Истинный поворот глаза в системе головы при взгляде на точку: h к носу > 0, v вверх > 0 (градусы). */
export function trueGazeDeg(eye: V3, target: V3, Rimg: M3, side: Side): { h: number; v: number } {
  const g = mv(tr(Rimg), sub(target, eye));
  return {
    h: (side === 'right' ? 1 : -1) * toDeg(Math.atan2(g[0], -g[2])),
    v: toDeg(Math.atan2(-g[1], Math.hypot(g[0], g[2]))),
  };
}

/** Размер CSS-пикселя по диагонали экрана (дюймы) и размеру экрана в CSS px. */
export const mmPerCssPxFromDiagonal = (diagInch: number, screenWCss: number, screenHCss: number): number =>
  (diagInch * 25.4) / Math.hypot(screenWCss, screenHCss);

/** Размер CSS-пикселя по длинной стороне карты (85,6 мм) в CSS px. */
export const mmPerCssPxFromCard = (longSideCssPx: number): number => 85.6 / longSideCssPx;
