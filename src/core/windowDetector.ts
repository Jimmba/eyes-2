// Детектор срыва по окну и собственной базе попытки (по разбору журнала замера 24 ноября).
// Почему не по нулю: один кадр даёт вергенцию с шумом ±3-5°, а «слитый» уровень между попытками гуляет на ±3° от нуля,
// поэтому порог относительно нуля пришлось бы ставить выше самого срыва (≈11° против срывов в 6-16°).
// Здесь сигнал это медиана за окно ~1 с, а сравнивается он с базой: медианой слитых кадров за предыдущие секунды.
import { median } from './filters';
import type { DetEvent, DetSample } from './breakDetector';

export interface WinOpts {
  thresholdDeg: number; // T: отклонение окна от базы, °
  winMs: number; // окно сигнала
  minN: number; // минимум валидных кадров в окне
  baseFromMs: number; // база: слитые кадры за [t − baseFromMs, t − baseToMs]
  baseToMs: number;
  minBaseN: number;
  settleMs: number; // после старта и после возврата база копится заново, срывов не ищем
  persistMs: number; // сколько держится отклонение
  returnRatio: number; // возврат: |окно − база| < T · returnRatio
}
export const WIN_DEFAULTS: WinOpts = { thresholdDeg: 5, winMs: 1000, minN: 4, baseFromMs: 5000, baseToMs: 1000, minBaseN: 6, settleMs: 2500, persistMs: 500, returnRatio: 0.5 };
export const RETURN_SETTLE_MS = 2000;

interface Fr {
  t: number;
  v: number;
  z: number;
  fused: boolean;
}

/** Шум медианы окна в покое (для порога): стандартное отклонение скользящих медиан. */
export function windowNoise(ts: number[], xs: number[], winMs = 1000, minN = 4): number {
  const m: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const w: number[] = [];
    for (let j = i; j >= 0 && ts[i] - ts[j] < winMs; j--) if (Number.isFinite(xs[j])) w.push(xs[j]);
    if (ts[i] - ts[0] >= winMs && w.length >= minN) m.push(median(w));
  }
  if (m.length < 3) return NaN;
  const mu = m.reduce((a, b) => a + b, 0) / m.length;
  return Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / (m.length - 1));
}

export class WindowDetector {
  state: 'fused' | 'broken' = 'fused';
  private fr: Fr[] = [];
  private t0 = NaN;
  private settleUntil = NaN;
  private base: number | null = null; // база на момент срыва
  private lastBase: number | null = null;
  private run: { t: number; z: number } | null = null;
  private peak = 0;
  constructor(public opts: WinOpts = WIN_DEFAULTS) {}

  reset(): void {
    this.state = 'fused';
    this.fr = [];
    this.t0 = NaN;
    this.settleUntil = NaN;
    this.base = null;
    this.lastBase = null;
    this.run = null;
    this.peak = 0;
  }

  /** Пользователь сообщил о срыве (касание): считаем срыв, база та, что была до него. */
  forceBroken(): void {
    this.state = 'broken';
    this.base = this.lastBase;
    this.run = null;
    this.peak = 0;
    // кадры последних секунд уже не «слитые»: ими нельзя считать базу
    const cut = this.fr.length ? this.fr[this.fr.length - 1].t - this.opts.baseToMs : 0;
    for (const f of this.fr) if (f.t > cut) f.fused = false;
  }

  /** Пользователь сообщил о возврате (отпустил): слитое состояние, база копится заново. */
  forceFused(t: number): void {
    this.state = 'fused';
    this.run = null;
    this.settleUntil = t + RETURN_SETTLE_MS;
    for (const f of this.fr) f.fused = false;
  }

  push(s: DetSample): DetEvent | null {
    const o = this.opts;
    if (!s.valid || !Number.isFinite(s.value)) return null;
    if (!Number.isFinite(this.t0)) {
      this.t0 = s.t;
      this.settleUntil = s.t + o.settleMs;
    }
    this.fr.push({ t: s.t, v: s.value, z: s.z, fused: this.state === 'fused' });
    const keep = Math.max(o.baseFromMs, o.winMs) + 500;
    while (this.fr.length && s.t - this.fr[0].t > keep) this.fr.shift();

    const win = this.fr.filter((f) => s.t - f.t < o.winMs);
    if (win.length < o.minN) return null;
    const m = median(win.map((f) => f.v));

    if (this.state === 'fused') {
      const bs = this.fr.filter((f) => f.fused && s.t - f.t <= o.baseFromMs && s.t - f.t >= o.baseToMs);
      if (bs.length < o.minBaseN) return null;
      const B = median(bs.map((f) => f.v));
      this.lastBase = B;
      if (s.t < this.settleUntil) return null;
      const d = m - B;
      if (Math.abs(d) > o.thresholdDeg) {
        if (!this.run) this.run = { t: s.t, z: s.z };
        this.peak = Math.max(this.peak, Math.abs(d));
        if (s.t - this.run.t >= o.persistMs) {
          const ev: DetEvent = { type: 'break', t: s.t, onsetT: this.run.t, z: this.run.z, value: d, sign: d > 0 ? 1 : -1, peak: this.peak };
          this.state = 'broken';
          this.base = B;
          this.run = null;
          return ev;
        }
      } else {
        this.run = null;
        this.peak = 0;
      }
      return null;
    }

    // broken: ждём возврата к базе
    const B = this.base ?? this.lastBase ?? median(this.fr.map((f) => f.v));
    const d = m - B;
    this.peak = Math.max(this.peak, Math.abs(d));
    if (Math.abs(d) < o.thresholdDeg * o.returnRatio) {
      if (!this.run) this.run = { t: s.t, z: s.z };
      if (s.t - this.run.t >= o.persistMs) {
        const ev: DetEvent = { type: 'return', t: s.t, onsetT: this.run.t, z: this.run.z, value: d, sign: d > 0 ? 1 : -1, peak: this.peak };
        this.state = 'fused';
        this.run = null;
        this.peak = 0;
        this.settleUntil = s.t + RETURN_SETTLE_MS;
        for (const f of this.fr) f.fused = false; // кадры возвращения в базу не берём
        return ev;
      }
    } else this.run = null;
    return null;
  }
}
