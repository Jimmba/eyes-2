// Масштаб: размер радужки (3 метода из плана, раздел 4.1), фокусное расстояние и расстояние до камеры.
export const DEFAULT_IRIS_MM = 11.7;
export const CARD_WIDTH_MM = 85.6; // банковская карта ISO 7810 ID-1
export const CARD_HEIGHT_MM = 53.98;
export const IRIS_RANGE_MM: [number, number] = [10, 13.5]; // правдоподобный диапазон HVID

export type ScaleMethod = 'default' | 'manual' | 'card';
export interface ScaleSetup {
  method: ScaleMethod;
  irisMm: number;
}

export const defaultScale = (): ScaleSetup => ({ method: 'default', irisMm: DEFAULT_IRIS_MM });

/** (а) пользователь вводит диаметр радужки (HVID 11–12 мм; не диаметр контактной линзы 14–14,5 мм). */
export function manualScale(mm: number): ScaleSetup {
  if (!Number.isFinite(mm) || mm < 9 || mm > 14) throw new RangeError('Диаметр радужки вне диапазона 9–14 мм');
  return { method: 'manual', irisMm: mm };
}

/** (б) карта в плоскости лица: мм на пиксель = 85,6 / ширина карты в px; диаметр радужки = её px × мм/px. */
export function cardScale(irisPx: number, cardWidthPx: number): ScaleSetup {
  if (!(irisPx > 0) || !(cardWidthPx > 0)) throw new RangeError('Нужны положительные размеры в пикселях');
  return { method: 'card', irisMm: (irisPx * CARD_WIDTH_MM) / cardWidthPx };
}

export const isPlausibleIris = (mm: number): boolean => mm >= IRIS_RANGE_MM[0] && mm <= IRIS_RANGE_MM[1];

/** мм на пиксель в плоскости лица по радужке. */
export const mmPerPxFromIris = (irisMm: number, irisPx: number): number => irisMm / irisPx;

/** Запасной вариант фокусного расстояния (px): типичное вертикальное поле зрения (как в MediaPipe по умолчанию, 63°). */
export function focalFromVerticalFov(heightPx: number, fovDeg = 63): number {
  return heightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/** Калибровка фокусного расстояния по известной дистанции (линейка/карта): f = d·Z/D. */
export const focalFromKnownDistance = (irisPx: number, irisMm: number, distMm: number): number =>
  (irisPx * distMm) / irisMm;

/** Z = f·(мм/px). */
export const distanceMm = (focalPx: number, mmPerPx: number): number => focalPx * mmPerPx;

/** Вертикальное поле зрения (°) по фокусному расстоянию и высоте кадра. */
export const fovFromFocal = (heightPx: number, focalPx: number): number => (2 * Math.atan(heightPx / 2 / focalPx) * 180) / Math.PI;
export const FOV_RANGE_DEG: [number, number] = [40, 100];
export const isPlausibleFov = (deg: number): boolean => deg >= FOV_RANGE_DEG[0] && deg <= FOV_RANGE_DEG[1];

/**
 * Вертикальное поле зрения кадра w×h по диагональному полю зрения из паспорта камеры.
 * Допущение: сенсор 4:3, кадр вырезан из него без масштабирования (обрезка), без электронной стабилизации.
 * Ориентировочно: у многих телефонов обрезка и стабилизация меняют поле зрения, поэтому точнее мерить линейкой.
 */
export function fovVerticalFromDiagonal(diagDeg: number, w: number, h: number): number {
  const a = w / h;
  const landscape = a >= 1;
  const [sw, sh] = landscape ? [4, 3] : [3, 4]; // сенсор в ориентации кадра
  let W = landscape ? sw : sh * a;
  let H = landscape ? sw / a : sh;
  if (W > sw) {
    W = sw;
    H = sw / a;
  }
  if (H > sh) {
    H = sh;
    W = sh * a;
  }
  const u = Math.tan((diagDeg * Math.PI) / 360) / 2.5; // тангенс на единицу сенсора (полудиагональ = 2,5)
  return (2 * Math.atan((H / 2) * u) * 180) / Math.PI;
}
