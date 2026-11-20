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
