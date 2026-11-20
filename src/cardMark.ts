// Отметка четырёх углов карты на замороженном кадре: перетаскиваемые маркеры и лупа.
import type { P2 } from './core/card';

const CARD_ASPECT = 85.6 / 53.98;

export class CardMarker {
  active = false;
  private img: HTMLCanvasElement | null = null;
  private c: P2[] = []; // углы в пикселях полного кадра: верхний левый, верхний правый, нижний правый, нижний левый
  private drag = -1;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => (this.drag = -1));
    canvas.addEventListener('pointercancel', () => (this.drag = -1));
  }

  get corners(): P2[] {
    return this.c.map((p) => ({ ...p }));
  }

  start(img: HTMLCanvasElement): void {
    this.img = img;
    const w = img.width * 0.5;
    const h = w / CARD_ASPECT;
    const cx = img.width / 2;
    const cy = img.height / 2;
    this.c = [
      { x: cx - w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy + h / 2 },
      { x: cx - w / 2, y: cy + h / 2 },
    ];
    this.drag = -1;
    this.active = true;
    this.canvas.classList.add('marking');
  }

  stop(): void {
    this.active = false;
    this.drag = -1;
    this.img = null;
    this.canvas.classList.remove('marking');
  }

  private uiScale(): number {
    return this.canvas.width / this.canvas.getBoundingClientRect().width;
  }

  /** позиция указателя в пикселях холста (внутренних) */
  private canvasPos(e: PointerEvent): P2 {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.canvas.width, y: ((e.clientY - r.top) / r.height) * this.canvas.height };
  }

  private down(e: PointerEvent): void {
    if (!this.active || !this.img) return;
    const p = this.canvasPos(e);
    const s = this.canvas.width / this.img.width;
    const hit = 40 * this.uiScale();
    let best = -1;
    let bd = hit;
    this.c.forEach((c, i) => {
      const d = Math.hypot(c.x * s - p.x, c.y * s - p.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best >= 0) {
      this.drag = best;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  private move(e: PointerEvent): void {
    if (!this.active || !this.img || this.drag < 0) return;
    const p = this.canvasPos(e);
    const s = this.canvas.width / this.img.width;
    this.c[this.drag] = {
      x: Math.min(this.img.width, Math.max(0, p.x / s)),
      y: Math.min(this.img.height, Math.max(0, p.y / s)),
    };
    e.preventDefault();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const img = this.img;
    if (!img) return;
    const pw = this.canvas.width;
    const ph = this.canvas.height;
    const s = pw / img.width;
    const u = this.uiScale();
    ctx.drawImage(img, 0, 0, pw, ph);

    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = '#ffd54f';
    ctx.beginPath();
    this.c.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
    ctx.closePath();
    ctx.stroke();
    this.c.forEach((p, i) => {
      const x = p.x * s;
      const y = p.y * s;
      ctx.beginPath();
      ctx.arc(x, y, 14 * u, 0, Math.PI * 2);
      ctx.strokeStyle = i === this.drag ? '#ff5252' : '#ffd54f';
      ctx.stroke();
      ctx.beginPath(); // точка в центре: видно, где именно угол
      ctx.arc(x, y, 1.5 * u, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    });

    if (this.drag >= 0) this.loupe(ctx, img, s, pw);
  }

  private loupe(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, s: number, pw: number): void {
    const p = this.c[this.drag];
    const R = 0.17 * pw;
    const mag = 5; // увеличение относительно превью
    let lx = R + 8;
    const ly = R + 8;
    if (p.x * s < 2 * R + 24 && p.y * s < 2 * R + 24) lx = pw - R - 8; // не закрывать угол, который двигаем
    const sr = R / s / mag; // радиус области в пикселях полного кадра
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
    ctx.drawImage(img, p.x - sr, p.y - sr, 2 * sr, 2 * sr, lx - R, ly - R, 2 * R, 2 * R);
    ctx.restore();
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.moveTo(lx - 10, ly);
    ctx.lineTo(lx + 10, ly);
    ctx.moveTo(lx, ly - 10);
    ctx.lineTo(lx, ly + 10);
    ctx.stroke();
  }
}
