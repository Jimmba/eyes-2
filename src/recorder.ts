// Журнал CSV (только числа, без изображений). Один журнал на запуск калибровки: при её старте очищается.
// Сцена ставится автоматически окном (iris_card, face_model, zero) или разработчиком (dev:метка).
export const CSV_HEADER = [
  't_ms', 'scene', 'faces', 'fps',
  'R_dx', 'R_dy', 'R_open', 'R_iris_px',
  'L_dx', 'L_dy', 'L_open', 'L_iris_px',
  'yaw', 'pitch', 'roll', 'tz',
  'mm_px', 'z_mm', 'angR', 'angL', 'devR', 'devL', 'vergence', 'scale_method', 'iris_mm', 'dev_inst', 'event', 'user_hold', 'det_state', 'ex_phase', 'ex_target_cm',
].join(',');

export class Recorder {
  private rows: string[] = [CSV_HEADER];
  private t0 = performance.now();
  /** null: не пишем */
  scene: string | null = null;

  clear(): void {
    this.rows = [CSV_HEADER];
    this.t0 = performance.now();
    this.scene = null;
  }

  push(values: (number | string)[]): void {
    if (!this.scene) return;
    const t = Math.round(performance.now() - this.t0);
    const safe = this.scene.replace(/[",\n\r]/g, ' ');
    const cells = values.map((v) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(4) : '') : v));
    this.rows.push([t, `"${safe}"`, ...cells].join(','));
  }

  get count(): number {
    return Math.max(0, this.rows.length - 1);
  }

  download(prefix = 'log'): void {
    const blob = new Blob([this.rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
