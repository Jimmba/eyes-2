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

// ---- страницы: во весь экран (замеры, упражнения) или под видео (калибровка; видео нужно, чтобы видеть себя) ----
let closeCb: (() => void) | null = null;
let stageObs: ResizeObserver | null = null;
const placeBelowStage = (): void => {
  const r = $('stage').getBoundingClientRect();
  $('sheet').style.setProperty('--sheetTop', `${Math.max(0, Math.round(r.bottom + 6))}px`);
};
export const sheet = {
  get isOpen(): boolean {
    return !$('sheet').hidden;
  },
  /** Открыта страница во весь экран (видео под ней не нужно: превью не рисуем). */
  get isFull(): boolean {
    return !$('sheet').hidden && $('sheet').classList.contains('full');
  },
  /**
   * full: страница во весь экран; preview: страница под видео (видно себя); section: что открыто (Калибровка, Тренировка...);
   * head: заголовок с крестиком.
   */
  open(onClose?: () => void, opts: { full?: boolean; preview?: boolean; head?: boolean; section?: string } = {}): void {
    const el = $('sheet');
    el.classList.toggle('full', !!opts.full);
    el.classList.toggle('page', !!opts.preview && !opts.full);
    el.classList.toggle('nohead', opts.head === false);
    $('sheetSection').textContent = opts.section ?? '';
    el.hidden = false;
    closeCb = onClose ?? null;
    if (opts.preview && !opts.full) {
      document.body.classList.add('calib');
      window.scrollTo(0, 0);
      requestAnimationFrame(placeBelowStage);
      stageObs = new ResizeObserver(placeBelowStage);
      stageObs.observe($('stage'));
    }
  },
  /** Показать или спрятать заголовок с крестиком (в упражнении он не нужен: мишень у верхнего края). */
  head(show: boolean): void {
    $('sheet').classList.toggle('nohead', !show);
  },
  close(): void {
    $('sheet').hidden = true;
    $('sheet').classList.remove('full', 'nohead', 'page', 'holdmode');
    document.body.classList.remove('calib');
    stageObs?.disconnect();
    stageObs = null;
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

/**
 * Касание экрана в любом месте или пробел (на ноутбуке). Нажатия по кнопкам, полям и ссылкам не считаются.
 * Возвращает функцию отключения. Работает, только пока страница открыта.
 */
export function onTap(cb: () => void): () => void {
  const el = $('sheet');
  const click = (e: Event) => {
    if ((e.target as HTMLElement | null)?.closest('button, input, select, textarea, a, label')) return;
    cb();
  };
  const key = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || e.repeat || !sheet.isOpen) return;
    const tg = e.target as HTMLElement | null;
    if (tg && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName)) return;
    e.preventDefault(); // иначе пробел «нажмёт» кнопку в фокусе
    cb();
  };
  el.addEventListener('click', click);
  window.addEventListener('keydown', key, true);
  return () => {
    el.removeEventListener('click', click);
    window.removeEventListener('keydown', key, true);
  };
}

/**
 * Удержание: касание экрана в любом месте (или пробел на ноутбуке) нажато, пока длится срыв. down вызывается в момент
 * нажатия, up в момент отпускания. Нажатия по кнопкам, полям и ссылкам не считаются. Возвращает функцию отключения.
 */
export function onHold(down: () => void, up: () => void): () => void {
  const el = $('sheet');
  let holding = false;
  const press = () => {
    if (holding) return;
    holding = true;
    down();
  };
  const release = () => {
    if (!holding) return;
    holding = false;
    up();
  };
  const pdown = (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest('button, input, select, textarea, a, label')) return;
    press();
  };
  const kdown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || !sheet.isOpen) return;
    const tg = e.target as HTMLElement | null;
    if (tg && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName)) return;
    e.preventDefault();
    if (!e.repeat) press();
  };
  const kup = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    release();
  };
  const noMenu = (e: Event) => e.preventDefault(); // долгое касание иначе открывает меню выделения
  el.classList.add('holdmode');
  el.addEventListener('pointerdown', pdown);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  el.addEventListener('contextmenu', noMenu);
  window.addEventListener('keydown', kdown, true);
  window.addEventListener('keyup', kup, true);
  return () => {
    holding = false; // без вызова up: отметку закрывает сам вызывающий
    el.classList.remove('holdmode');
    el.removeEventListener('pointerdown', pdown);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    el.removeEventListener('contextmenu', noMenu);
    window.removeEventListener('keydown', kdown, true);
    window.removeEventListener('keyup', kup, true);
  };
}
