// Запись сырых чисел в CSV (без изображений) для проверки M0 на людях и на отклонённом глазе.
export const CSV_HEADER = [
  't_ms', 'label', 'faces', 'fps',
  'R_dx', 'R_dy', 'R_open', 'R_iris_px',
  'L_dx', 'L_dy', 'L_open', 'L_iris_px',
  'yaw', 'pitch', 'roll', 'tz',
  'mm_px', 'z_mm', 'angR', 'angL', 'devR', 'devL', 'vergence', 'scale_method', 'iris_mm',
].join(',');

export class Recorder {
  private rows: string[] = [];
  private t0 = 0;
  active = false;

  start(): void {
    this.rows = [CSV_HEADER];
    this.t0 = performance.now();
    this.active = true;
  }

  push(label: string, values: (number | string)[]): void {
    if (!this.active) return;
    const t = Math.round(performance.now() - this.t0);
    const safe = label.replace(/[",\n\r]/g, ' ');
    const nums = values.map((v) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(4) : '') : v));
    this.rows.push([t, `"${safe}"`, ...nums].join(','));
  }

  get count(): number {
    return Math.max(0, this.rows.length - 1);
  }

  stopAndDownload(): void {
    this.active = false;
    const blob = new Blob([this.rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `m0-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
