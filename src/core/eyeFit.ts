// Подгонка коэффициента «смещение → градусы» (план 4.5, M2): истинный угол = k·измеренный + b.
export interface GainFit {
  k: number;
  b: number;
  r2: number;
  rms: number; // остаток, °
  n: number;
  rangeDeg: number; // размах истинных углов
  ok: boolean;
}

/**
 * measVar: дисперсия шума в каждой измеренной точке (медиана кадров). Без поправки шум в «x» занижает наклон
 * (на узком экране телефона диапазон углов мал, и эффект заметен); поправка делит наклон на долю полезной дисперсии.
 */
export function fitGain(meas: number[], truth: number[], measVar = 0): GainFit {
  const n = Math.min(meas.length, truth.length);
  if (n < 2) return { k: NaN, b: NaN, r2: NaN, rms: NaN, n, rangeDeg: 0, ok: false };
  const mx = meas.slice(0, n).reduce((a, v) => a + v, 0) / n;
  const my = truth.slice(0, n).reduce((a, v) => a + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (meas[i] - mx) ** 2;
    sxy += (meas[i] - mx) * (truth[i] - my);
    syy += (truth[i] - my) ** 2;
  }
  const sxxAdj = sxx - n * measVar;
  const k = sxxAdj > 0.3 * sxx ? sxy / sxxAdj : sxy / sxx; // слишком сильный шум: поправку не применяем (оценка занижена)
  const b = my - k * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (truth[i] - (k * meas[i] + b)) ** 2;
  const r2 = syy > 0 ? 1 - ss / syy : 0;
  const rangeDeg = Math.max(...truth.slice(0, n)) - Math.min(...truth.slice(0, n));
  return { k, b, r2, rms: Math.sqrt(ss / n), n, rangeDeg, ok: n >= 6 && rangeDeg >= 3 && k >= 0.4 && k <= 2 && r2 >= 0.6 && sxxAdj > 0.3 * sxx };
}

/** Общий коэффициент по нескольким дистанциям (среднее по удачным подгонкам). */
export function combineGains(fits: GainFit[]): { k: number; spread: number } | null {
  const ok = fits.filter((f) => f.ok);
  if (!ok.length) return null;
  const ks = ok.map((f) => f.k);
  const k = ks.reduce((a, v) => a + v, 0) / ks.length;
  return { k, spread: ks.length > 1 ? Math.abs(Math.max(...ks) - Math.min(...ks)) / k : 0 };
}
