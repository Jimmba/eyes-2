// Общие помощники экранов мастеров (калибровка, точная калибровка, тренировка).
import { Cancel, h, sheet } from './ui';

export interface Btn {
  key: string;
  label: string;
  primary?: boolean;
}

export const p = (text: string, cls = ''): HTMLParagraphElement => h('p', { class: cls }, text);
export const why = (label: string, text: string): HTMLParagraphElement => h('p', { class: 'why' }, h('b', null, label), text);
export const fmtDate = (ms: number): string => new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
export const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString('ru-RU', { timeStyle: 'short' });
export const sg = (x: number, d = 1): string => (x >= 0 ? '+' : '') + x.toFixed(d);

/** Показывает окно с кнопками и возвращает ключ нажатой кнопки ('cancel', если окно закрыто). */
export function makeScreen(cancel: Cancel) {
  return (title: string, nodes: (Node | null | false)[], btns: Btn[]): Promise<string> =>
    new Promise((resolve) => {
      const row = h('div', { class: 'btnrow' }, ...btns.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => resolve(b.key) }, b.label)));
      sheet.set(title, ...nodes, row);
      void cancel.promise.then(() => resolve('cancel'));
    });
}
