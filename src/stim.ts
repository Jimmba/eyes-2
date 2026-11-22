// Полноэкранный слой для стимулов: точки сетки и рамка карты при калибровке размера экрана.
const $ = (id: string) => document.getElementById(id) as HTMLElement;

export const stim = {
  fullscreen: false,
  async open(msg = ''): Promise<void> {
    $('stim').hidden = false;
    $('stimMsg').textContent = msg;
    $('stimDot').hidden = true;
    $('stimFrame').hidden = true;
    $('stimCtl').hidden = true;
    stim.fullscreen = false;
    try {
      await document.documentElement.requestFullscreen?.();
      stim.fullscreen = !!document.fullscreenElement;
    } catch {
      /* не удалось: камера считается относительно верхнего края окна, вертикальный коэффициент не подгоняется */
    }
  },
  async close(): Promise<void> {
    $('stim').hidden = true;
    $('stimDot').hidden = true;
    $('stimFrame').hidden = true;
    $('stimCtl').hidden = true;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
    stim.fullscreen = false;
  },
  msg(text: string, big = false): void {
    const el = $('stimMsg');
    el.textContent = text;
    el.className = big ? 'big' : '';
  },
  dot(u: number, v: number): void {
    const d = $('stimDot');
    d.hidden = false;
    d.style.left = `${u}px`;
    d.style.top = `${v}px`;
  },
  hideDot(): void {
    $('stimDot').hidden = true;
  },
  /** Размеры видимой области в CSS px */
  size(): { w: number; h: number } {
    const el = $('stim');
    return { w: el.clientWidth, h: el.clientHeight };
  },
};
