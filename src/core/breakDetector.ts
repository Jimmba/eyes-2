// Детектор срыва (план, раздел 8). Сигнал: вергенция относительно личного нуля, °.
// Пороги в долях секунды (а не в кадрах), потому что частота на телефоне 6-30 кадр/с.
import { median, std } from './filters';

export interface DetOpts {
  thresholdDeg: number; // T
  breakMs: number; // сколько держится |сигнал| > T
  breakFrames: number; // и не меньше стольких кадров
  returnRatio: number; // порог возврата = T · returnRatio (гистерезис)
  returnMs: number; // сколько держится |сигнал| < T · returnRatio
  returnFrames: number;
  medianLen: number; // медиана по последним валидным кадрам
  blinkCooldown: number; // кадров после невалидного кадра тоже пропускаем
}
export const DET_DEFAULTS: DetOpts = { thresholdDeg: 3, breakMs: 400, breakFrames: 3, returnRatio: 0.6, returnMs: 500, returnFrames: 3, medianLen: 3, blinkCooldown: 2 };

export interface DetSample {
  t: number; // мс
  value: number; // вергенция от нуля, °
  valid: boolean;
  z: number; // дистанция, мм
}
export interface DetEvent {
  type: 'break' | 'return';
  t: number; // момент подтверждения
  onsetT: number; // первый кадр, где порог пройден (для срыва) или возврат начался
  z: number; // дистанция в onset
  value: number; // сигнал в onset
  sign: 1 | -1;
  peak: number; // максимум |сигнала| в периоде срыва
}

/** Порог по плану: T = 3° и не меньше трёх стандартных отклонений отфильтрованного шума в покое. */
export function thresholdFromNoise(restSignal: number[], opts: DetOpts = DET_DEFAULTS): { sigma: number; threshold: number } {
  const filt: number[] = [];
  const buf: number[] = [];
  for (const v of restSignal) {
    if (!Number.isFinite(v)) continue;
    buf.push(v);
    if (buf.length > opts.medianLen) buf.shift();
    filt.push(median(buf));
  }
  const sigma = std(filt);
  return { sigma, threshold: Math.max(opts.thresholdDeg, 3 * (Number.isFinite(sigma) ? sigma : 0)) };
}

export class BreakDetector {
  state: 'fused' | 'broken' = 'fused';
  private buf: number[] = [];
  private cooldown = 0;
  private run: { t: number; z: number; value: number; count: number } | null = null;
  private peak = 0;
  constructor(public opts: DetOpts = DET_DEFAULTS) {}

  reset(): void {
    this.state = 'fused';
    this.buf = [];
    this.cooldown = 0;
    this.run = null;
    this.peak = 0;
  }

  push(s: DetSample): DetEvent | null {
    if (!s.valid || !Number.isFinite(s.value)) {
      this.cooldown = this.opts.blinkCooldown;
      return null;
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      return null;
    }
    this.buf.push(s.value);
    if (this.buf.length > this.opts.medianLen) this.buf.shift();
    const f = median(this.buf);
    const T = this.opts.thresholdDeg;

    if (this.state === 'fused') {
      if (Math.abs(f) > T) {
        if (!this.run) {
          this.run = { t: s.t, z: s.z, value: f, count: 1 };
          this.peak = Math.abs(f);
        } else {
          this.run.count++;
          this.peak = Math.max(this.peak, Math.abs(f));
        }
        if (this.run.count >= this.opts.breakFrames && s.t - this.run.t >= this.opts.breakMs) {
          const r = this.run;
          this.state = 'broken';
          this.run = null;
          return { type: 'break', t: s.t, onsetT: r.t, z: r.z, value: r.value, sign: r.value >= 0 ? 1 : -1, peak: this.peak };
        }
      } else this.run = null;
    } else {
      this.peak = Math.max(this.peak, Math.abs(f));
      if (Math.abs(f) < T * this.opts.returnRatio) {
        if (!this.run) this.run = { t: s.t, z: s.z, value: f, count: 1 };
        else this.run.count++;
        if (this.run.count >= this.opts.returnFrames && s.t - this.run.t >= this.opts.returnMs) {
          const r = this.run;
          this.state = 'fused';
          this.run = null;
          return { type: 'return', t: s.t, onsetT: r.t, z: r.z, value: r.value, sign: 1, peak: this.peak };
        }
      } else this.run = null;
    }
    return null;
  }
}

/** Стоп-условие плана (раздел 13): результат упал более чем на 30 % от первых трёх повторов. */
export function droppedTooMuch(distances: number[]): boolean {
  if (distances.length < 4) return false;
  const base = median(distances.slice(0, 3));
  return distances[distances.length - 1] < 0.7 * base;
}

export const medianOf = median;
