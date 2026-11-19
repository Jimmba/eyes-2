// Снимок для самопроверки меток: превью с контурами + кроп глаз + числа. Сохраняется только на устройство.
export function saveSnapshot(
  view: HTMLCanvasElement,
  cropR: HTMLCanvasElement,
  cropL: HTMLCanvasElement,
  text: string,
): void {
  const W = view.width;
  const cropH = Math.round(W / 4);
  const lines = text.split('\n');
  const lh = 18;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = view.height + cropH + lines.length * lh + 12;
  const g = c.getContext('2d')!;
  g.fillStyle = '#101418';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(view, 0, 0);
  g.drawImage(cropR, 0, view.height, W / 2, cropH);
  g.drawImage(cropL, W / 2, view.height, W / 2, cropH);
  g.fillStyle = '#e8eaed';
  g.font = '13px monospace';
  lines.forEach((l, i) => g.fillText(l, 6, view.height + cropH + 16 + i * lh));
  c.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `m0-snap-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}
