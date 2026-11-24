// Ноль: положение глаз при слиянии на комфортной дистанции. Нужен в каждой новой сессии (поза и свет другие), поэтому
// это отдельный пункт меню, а не шаг калибровки. Шаг можно вызвать и изнутри замера или тренировки: после него
// пользователь возвращается на тот же экран.
import type { Env } from './calibration';
import { DET_DEFAULTS, thresholdFromNoise } from './core/breakDetector';
import { std, windowStat } from './core/filters';
import { t } from './i18n';
import { FrameInfo, app, zeroValid } from './state';
import { Cancel, h, sheet, timedCapture } from './ui';
import { fmtTime, makeScreen, p, sg, why } from './wizard';

export const ZERO_FRESH_H = 3; // ноль старше этого считается устаревшим (новая сессия): предлагаем пройти заново

export const zeroAgeH = (): number => (app.zero ? (Date.now() - app.zero.at) / 3.6e6 : Infinity);

interface Ctx {
  env: Env;
  cancel: Cancel;
  screen: ReturnType<typeof makeScreen>;
}

/**
 * Один проход нуля. force: не спрашивать «пропустить, если ноль уже есть». Возвращает false, если пользователь закрыл окно.
 */
export async function runZeroStep(c: Ctx, title: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const { env, cancel, screen } = c;
  if (!opts.force && zeroValid() && app.zero) {
    const z = app.zero;
    const a = await screen(
      title,
      [why(t.whyLabel, t.s3Why), p(`${t.s3Saved} (${fmtTime(z.at)}): правый ${sg(z.R)}°, левый ${sg(z.L)}°, ${t.dist} ${(z.z / 10).toFixed(0)} см.`, 'big')],
      [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }],
    );
    if (a === 'cancel') return false;
    if (a === 'skip') return true;
  }
  for (;;) {
    const a = await screen(title, [why(t.whyLabel, t.s3Why), p(t.s3How)], [{ key: 'go', label: t.start2, primary: true }]);
    if (a === 'cancel') return false;
    sheet.set(title, p(t.s3Wait, 'big'));
    const S: FrameInfo[] = [];
    const sink = (i: FrameInfo) => {
      if (i.face) S.push(i);
    };
    app.sinks.add(sink);
    const ok = await timedCapture({ prep: 3, duration: 6, cancel, onStart: () => (env.recorder.scene = 'zero'), onEnd: () => (env.recorder.scene = null) });
    app.sinks.delete(sink);
    if (!ok) return false;
    const open = S.map((s) => s.open);
    const stR = windowStat(S.map((s) => s.angR), open, 8);
    const stL = windowStat(S.map((s) => s.angL), open, 8);
    const stZ = windowStat(S.map((s) => s.z), open, 8);
    const stI = windowStat(S.map((s) => s.ipd), open, 8);
    if (!(stR.ok && stL.ok && stZ.ok)) {
      const r = await screen(title, [p(t.s3Few, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
      if (r === 'cancel') return false;
      continue;
    }
    const nodes: Node[] = [
      h('p', { class: 'big' }, `${t.s3Result}: правый ${sg(stR.median)}°, левый ${sg(stL.median)}°`),
      p(`${t.dist} ${(stZ.median / 10).toFixed(0)} см, надёжных кадров ${stR.n} из ${stR.total}.`),
    ];
    if (std(S.map((s) => s.angR)) > 1.5 || std(S.map((s) => s.angL)) > 1.5 || stR.std > 1.5 || stL.std > 1.5) nodes.push(p(t.s3Unstable, 'warn'));
    if (stZ.median < 250 || stZ.median > 700) nodes.push(p(t.s3Dist, 'warn'));
    const k = await screen(title, nodes, [{ key: 'save', label: t.next, primary: true }, { key: 'redo', label: t.redo }]);
    if (k === 'cancel') return false;
    if (k === 'save') {
      const noise = thresholdFromNoise(S.map((x) => x.angR + x.angL), DET_DEFAULTS);
      app.zero = { R: stR.median, L: stL.median, z: stZ.median, ipd: stI.median, irisMm: app.iris.irisMm, sigma: noise.sigma, at: Date.now() };
      env.refresh();
      return true;
    }
  }
}

/** Пункт меню «Ноль»: всегда новый проход (в начале сессии). */
export async function runZeroMenu(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  }, { full: true, section: t.zeroName });
  const screen = makeScreen(cancel);
  if (!(await env.ensureCamera())) {
    sheet.set(t.zeroName, p(t.needCamera));
    return;
  }
  if (!app.model) {
    await screen(t.zeroName, [p(t.trNeedCalib, 'warn')], [{ key: 'close', label: t.close, primary: true }]);
    return sheet.close();
  }
  const ok = await runZeroStep({ env, cancel, screen }, t.zeroName, { force: true });
  if (ok) await screen(t.zeroName, [p(t.zeroSaved, 'big')], [{ key: 'close', label: t.close, primary: true }]);
  sheet.close();
}
