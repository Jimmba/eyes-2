// Упражнение «Удержание на границе» (план, раздел 7): чистая логика без интерфейса.
// Приложение командует: займите дистанцию, держите; при срыве «ближе», после слияния снова держите;
// удержали успешно: «чуть дальше» (ступень вверх); два ранних срыва: ступень вниз (лестница плана).
// Направление: dir = +1 (срыв при отдалении, «труднее» значит дальше) или −1 (срыв при приближении).

export type HoldPhase = 'enter' | 'hold' | 'recover' | 'up' | 'down' | 'done';
export type HoldStyle = 'go' | 'warn' | 'near' | 'brk' | 'idle';
export type HoldKey = 'enter' | 'hold' | 'closer' | 'farther' | 'recover' | 'up' | 'down' | 'face' | 'done';
export interface HoldCommand {
  key: HoldKey;
  style: HoldStyle;
}
export interface HoldCfg {
  dir: 1 | -1;
  breakCm: number; // граница по замеру перед упражнением
  returnCm: number; // NaN, если возврата не было
  totalSec: number;
  successSec: number; // сколько держать слияние для ступени вверх
}
export const HOLD_DEFAULTS = { totalSec: 180, successSec: 20 };
export type HoldStop = 'time' | 'user' | 'rule' | null;

export interface BreakRec {
  cm: number;
  src: 'camera' | 'tap';
  tSec: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);

export class HoldController {
  phase: HoldPhase = 'enter';
  H: number; // целевая дистанция, см
  readonly H0: number;
  readonly hHard: number;
  readonly hEasy: number;
  holdMs = 0; // непрерывное удержание текущей ступени
  longestHoldMs = 0;
  fusedMs = 0; // время в слиянии за упражнение
  ups = 0;
  downs = 0;
  bestHoldCm = NaN;
  breaks: BreakRec[] = [];
  returns: BreakRec[] = [];
  stop: HoldStop = null;
  atLimit = false;

  private startT = NaN;
  private lastT = NaN;
  private phaseT = 0;
  private bandMs = 0; // сколько подряд в полосе (для входа)
  private side: -1 | 0 | 1 = 0;
  private early = 0; // ранние срывы подряд
  private recent: number[] = [];

  constructor(readonly cfg: HoldCfg) {
    const { dir, breakCm: b, returnCm: r } = cfg;
    const lo = Number.isFinite(r) ? Math.min(b, r) : -Infinity;
    const hi = Number.isFinite(r) ? Math.max(b, r) : Infinity;
    this.H0 = clamp(b * (1 - 0.05 * dir), lo, hi);
    this.H = this.H0;
    this.hHard = b * (1 + dir * 0.15);
    const ref = Number.isFinite(r) ? r : b * (1 - 0.1 * dir);
    this.hEasy = dir > 0 ? Math.max(15, 0.9 * ref) : Math.min(150, 1.1 * ref);
    this.H = dir > 0 ? Math.max(this.H0, this.hEasy) : Math.min(this.H0, this.hEasy);
  }

  get tol(): number {
    return Math.max(2, 0.06 * this.H);
  }
  get step(): number {
    return Math.max(2, 0.03 * this.H);
  }
  get elapsedSec(): number {
    return Number.isFinite(this.startT) && Number.isFinite(this.lastT) ? (this.lastT - this.startT) / 1000 : 0;
  }
  get holdSec(): number {
    return this.holdMs / 1000;
  }

  /** «Труднее» сторона полосы: при отдалении дальше. */
  private hard(z: number): boolean {
    return this.cfg.dir > 0 ? z > this.H : z < this.H;
  }

  private to(p: HoldPhase, t: number): void {
    this.phase = p;
    this.phaseT = t;
    this.bandMs = 0;
  }

  /** Один шаг времени: zCm это дистанция (быстро сглаженная), faceOk это лицо видно и кадр годный. */
  tick(t: number, zCm: number, faceOk: boolean): void {
    if (this.phase === 'done') return;
    if (!Number.isFinite(this.startT)) {
      this.startT = t;
      this.phaseT = t;
    }
    const dt = Number.isFinite(this.lastT) ? clamp(t - this.lastT, 0, 500) : 0;
    this.lastT = t;
    if (this.elapsedSec >= this.cfg.totalSec) return this.finish('time');
    if (!faceOk || !Number.isFinite(zCm)) return; // лицо потеряно: время ступени стоит

    // полоса с гистерезисом, чтобы команда не мигала на краю
    const off = Math.abs(zCm - this.H);
    if (off > this.tol * 1.15) this.side = zCm > this.H ? 1 : -1;
    else if (off < this.tol * 0.85) this.side = 0;

    if (this.phase === 'up' || this.phase === 'down') {
      if (t - this.phaseT >= 3000) this.to('enter', t);
      return;
    }
    if (this.phase === 'recover') return;
    if (this.phase === 'enter') {
      this.bandMs = this.side === 0 ? this.bandMs + dt : 0;
      if (this.bandMs >= 1000) {
        this.to('hold', t);
        this.holdMs = 0;
      }
      return;
    }
    // hold
    this.fusedMs += dt;
    const easySide = this.cfg.dir > 0 ? zCm < this.H - this.tol : zCm > this.H + this.tol; // слишком легко: не засчитываем
    if (!easySide) this.holdMs += dt;
    this.longestHoldMs = Math.max(this.longestHoldMs, this.holdMs);
    if (this.holdMs >= this.cfg.successSec * 1000) this.success(t);
  }

  private success(t: number): void {
    const { dir } = this.cfg;
    this.bestHoldCm = !Number.isFinite(this.bestHoldCm) ? this.H : dir > 0 ? Math.max(this.bestHoldCm, this.H) : Math.min(this.bestHoldCm, this.H);
    this.ups++;
    this.holdMs = 0;
    this.early = 0;
    const next = dir > 0 ? Math.min(this.H + this.step, this.hHard) : Math.max(this.H - this.step, this.hHard);
    if (Math.abs(next - this.H) < 0.01) {
      this.atLimit = true; // выше нельзя: продолжаем держать
      return;
    }
    this.H = next;
    this.side = 0;
    this.to('up', t);
  }

  /** Срыв: камера или касание. Возвращает true, если принят. */
  onBreak(zCm: number, t: number, src: 'camera' | 'tap'): boolean {
    if (this.phase === 'recover' || this.phase === 'done') return false;
    this.breaks.push({ cm: zCm, src, tSec: this.elapsedSec });
    this.early = this.holdMs < 10000 ? this.early + 1 : 0;
    this.holdMs = 0;
    this.recent = this.recent.filter((x) => t - x < 30000);
    this.recent.push(t);
    this.to('recover', t);
    const atFloor = Math.abs(this.H - this.hEasy) < 0.01 || (this.cfg.dir > 0 ? this.H <= this.hEasy : this.H >= this.hEasy);
    if (atFloor && this.recent.length >= 3) this.finish('rule');
    return true;
  }

  /** Возврат слияния: камера или касание. */
  onReturn(zCm: number, t: number, src: 'camera' | 'tap'): boolean {
    if (this.phase !== 'recover') return false;
    this.returns.push({ cm: zCm, src, tSec: this.elapsedSec });
    if (this.early >= 2) {
      const { dir } = this.cfg;
      const next = dir > 0 ? Math.max(this.H - this.step, this.hEasy) : Math.min(this.H + this.step, this.hEasy);
      this.early = 0;
      if (Math.abs(next - this.H) > 0.01) {
        this.H = next;
        this.downs++;
        this.side = 0;
        this.to('down', t);
        return true;
      }
    }
    this.to('enter', t);
    return true;
  }

  finish(reason: Exclude<HoldStop, null>): void {
    if (this.phase === 'done') return;
    this.stop = reason;
    this.phase = 'done';
  }

  command(faceOk: boolean, zCm: number): HoldCommand {
    if (this.phase === 'done') return { key: 'done', style: 'idle' };
    if (!faceOk) return { key: 'face', style: 'idle' };
    if (this.phase === 'recover') return { key: 'recover', style: 'brk' };
    if (this.phase === 'up') return { key: 'up', style: 'go' };
    if (this.phase === 'down') return { key: 'down', style: 'near' };
    if (this.side === 0 || !Number.isFinite(zCm)) return { key: this.phase === 'hold' ? 'hold' : 'enter', style: 'go' };
    const tooFar = this.side > 0; // дальше цели: нужно ближе
    const key: HoldKey = tooFar ? 'closer' : 'farther';
    const hardSide = this.cfg.dir > 0 ? tooFar : !tooFar;
    return { key, style: hardSide ? 'warn' : 'near' };
  }

  /** Положение отметки на шкале 0..1 (слева ближе, справа дальше); полоса цели в центре 37,5..62,5 %. */
  gaugePos(zCm: number): number {
    if (!Number.isFinite(zCm)) return 0.5;
    return clamp(0.5 + (zCm - this.H) / (8 * this.tol), 0, 1);
  }
}
