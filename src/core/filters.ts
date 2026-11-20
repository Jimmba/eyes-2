// Шум (план 4.8): исключение морганий (±3 кадра), окна с медианой, сглаживание One Euro для показаний.
export function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

export function std(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

export interface BlinkOpts {
  ratio: number; // кадр плохой, если раскрытие < ratio × медианное раскрытие окна
  abs: number; // или меньше абсолютного порога
  pad: number; // и по pad кадров вокруг
}
export const BLINK_DEFAULTS: BlinkOpts = { ratio: 0.75, abs: 0.15, pad: 3 };

/** true = кадр исключается (моргание или соседний с ним, либо нет данных). */
export function blinkMask(open: number[], o: BlinkOpts = BLINK_DEFAULTS): boolean[] {
  const base = median(open.filter(Number.isFinite));
  const thr = Math.max(o.abs, o.ratio * base);
  const raw = open.map((v) => !Number.isFinite(v) || v < thr);
  return raw.map((_, i) => {
    for (let d = -o.pad; d <= o.pad; d++) if (raw[i + d]) return true;
    return false;
  });
}

export interface WindowStat {
  median: number;
  std: number;
  n: number; // хороших кадров
  total: number;
  validFraction: number;
  /** Замер валиден, если хороших кадров не менее 70 % (план, раздел 9) и их не меньше minGood. */
  ok: boolean;
}

export function windowStat(values: number[], open: number[], minGood = 5, o: BlinkOpts = BLINK_DEFAULTS): WindowStat {
  const bad = blinkMask(open, o);
  const good = values.filter((v, i) => !bad[i] && Number.isFinite(v));
  const frac = values.length ? good.length / values.length : 0;
  return { median: median(good), std: std(good), n: good.length, total: values.length, validFraction: frac, ok: frac >= 0.7 && good.length >= minGood };
}

/** Окно по времени (план: 1–2 с). */
export class TimeWindow<T extends { t: number }> {
  items: T[] = [];
  constructor(public spanMs = 1500) {}
  push(x: T): void {
    this.items.push(x);
    const t0 = x.t - this.spanMs;
    while (this.items.length && this.items[0].t < t0) this.items.shift();
  }
  clear(): void {
    this.items = [];
  }
}

/** One Euro filter (Casiez и др.): меньше лага при быстрых движениях, сильнее сглаживание в покое. */
export class OneEuro {
  private x?: number;
  private dx = 0;
  private t?: number;
  constructor(public minCutoff = 0.8, public beta = 0.2, public dCutoff = 1) {}
  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, tMs: number): number {
    if (this.x === undefined || this.t === undefined) {
      this.x = v;
      this.t = tMs;
      return v;
    }
    const dt = (tMs - this.t) / 1000;
    if (dt <= 0) return this.x;
    const dRaw = (v - this.x) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    this.dx = aD * dRaw + (1 - aD) * this.dx;
    const a = this.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * v + (1 - a) * this.x;
    this.t = tMs;
    return this.x;
  }
  reset(): void {
    this.x = undefined;
    this.t = undefined;
    this.dx = 0;
  }
}
