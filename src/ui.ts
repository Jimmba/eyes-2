// Мелкие помощники интерфейса: DOM-конструктор, рамка по периметру экрана, таймеры, нижнее окно.
const $ = (id: string) => document.getElementById(id) as HTMLElement;

type Kid = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

// ---- рамка по периметру экрана: красная идёт запись, зелёная закончено ----
let greenTimer: ReturnType<typeof setTimeout> | null = null;
export function setBorder(mode: 'off' | 'red' | 'green'): void {
  const el = $('frame');
  if (greenTimer) clearTimeout(greenTimer);
  greenTimer = null;
  el.className = mode === 'off' ? '' : mode;
  if (mode === 'green') greenTimer = setTimeout(() => (el.className = ''), 3000);
}

// ---- отмена: закрытие окна прерывает любой шаг ----
export class Cancel {
  cancelled = false;
  private res: () => void = () => {};
  readonly promise = new Promise<void>((r) => (this.res = r));
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.res();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function wait(ms: number, c: Cancel): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (c.cancelled) return true;
    await sleep(Math.min(50, end - performance.now()));
  }
  return c.cancelled;
}

/**
 * Захват с таймерами: prep секунд до начала (крупная цифра у верхнего края, рядом с камерой),
 * затем duration секунд записи (красная рамка), по окончании автостоп и зелёная рамка.
 * Возвращает false, если прервано. Звука и вибрации нет.
 */
export async function timedCapture(o: { prep: number; duration: number; cancel: Cancel; onStart?: () => void; onEnd?: () => void }): Promise<boolean> {
  const timer = $('timer');
  const stopUi = () => {
    timer.hidden = true;
    timer.className = '';
  };
  try {
    timer.hidden = false;
    timer.className = 'prep';
    for (let s = o.prep; s > 0; s--) {
      timer.textContent = String(s);
      if (await wait(1000, o.cancel)) return false;
    }
    timer.className = 'rec';
    setBorder('red');
    o.onStart?.();
    const end = performance.now() + o.duration * 1000;
    while (performance.now() < end) {
      timer.textContent = `● ${Math.ceil((end - performance.now()) / 1000)} с`;
      if (await wait(200, o.cancel)) {
        setBorder('off');
        return false;
      }
    }
    setBorder('green');
    return true;
  } finally {
    o.onEnd?.();
    stopUi();
  }
}

/**
 * Захват до события: prep секунд до начала, затем запись (красная рамка) не дольше maxSec секунд;
 * заканчивается раньше, как только isDone() вернёт true (зелёная рамка). Звука нет.
 */
export async function captureUntil(o: { prep: number; maxSec: number; cancel: Cancel; isDone: () => boolean; onStart?: () => void; onEnd?: () => void }): Promise<'done' | 'timeout' | 'cancel'> {
  const timer = $('timer');
  try {
    timer.hidden = false;
    timer.className = 'prep';
    for (let s = o.prep; s > 0; s--) {
      timer.textContent = String(s);
      if (await wait(1000, o.cancel)) return 'cancel';
    }
    timer.className = 'rec';
    setBorder('red');
    o.onStart?.();
    const end = performance.now() + o.maxSec * 1000;
    while (performance.now() < end) {
      if (o.isDone()) {
        setBorder('green');
        return 'done';
      }
      timer.textContent = `● ${Math.ceil((end - performance.now()) / 1000)} с`;
      if (await wait(100, o.cancel)) {
        setBorder('off');
        return 'cancel';
      }
    }
    setBorder('green');
    return 'timeout';
  } finally {
    o.onEnd?.();
    timer.hidden = true;
    timer.className = '';
  }
}

// ---- нижнее окно (видео остаётся видимым над ним) ----
let closeCb: (() => void) | null = null;
export const sheet = {
  get isOpen(): boolean {
    return !$('sheet').hidden;
  },
  open(onClose?: () => void): void {
    $('sheet').hidden = false;
    closeCb = onClose ?? null;
  },
  close(): void {
    $('sheet').hidden = true;
    const cb = closeCb;
    closeCb = null;
    cb?.();
  },
  set(title: string, ...nodes: Kid[]): void {
    $('sheetTitle').textContent = title;
    $('sheetBody').replaceChildren(...(nodes.filter(Boolean) as (Node | string)[]));
    $('sheetBody').scrollTop = 0;
  },
};
$('sheetClose').addEventListener('click', () => sheet.close());
