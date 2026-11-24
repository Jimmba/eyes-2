// Проверка расстояния: вы задаёте известное расстояние (лист A4, линейка), приложение показывает, что оно измерило.
// При заметной разнице можно подогнать поправку (множитель); она хранится для камеры и разрешения.
import type { Env } from './calibration';
import { median } from './core/filters';
import { t } from './i18n';
import { FrameInfo, app, currentDistK, setDistK } from './state';
import { Cancel, h, sheet, timedCapture } from './ui';
import { makeScreen, p } from './wizard';

const A4_LONG_CM = 29.7;

export async function runDistanceCheck(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.recorder.scene = null;
  }, { full: true, section: t.menuDist });
  const screen = makeScreen(cancel);
  if (!(await env.ensureCamera())) {
    sheet.set(t.distCheckName, p(t.needCamera));
    return;
  }
  for (let k = 0; k < 30 && !app.lastInfo; k++) await new Promise((r) => setTimeout(r, 100));

  for (;;) {
    const input = h('input', { type: 'number', min: '15', max: '100', step: '0.1', value: String(A4_LONG_CM) });
    const a = await screen(t.distCheckName, [p(t.distCheckWhy, 'why'), p(t.distCheckHow), h('p', null, t.distInput + ': ', input)], [{ key: 'go', label: t.start2, primary: true }, { key: 'close', label: t.close }]);
    if (a === 'cancel' || a === 'close') break;
    const real = Number(input.value) * 10;
    if (!(real >= 150 && real <= 1000)) continue;

    sheet.set(t.distCheckName, p(t.distWait, 'big'));
    const S: FrameInfo[] = [];
    const stop = (() => {
      const cb = (i: FrameInfo) => {
        if (i.face && i.valid && Number.isFinite(i.zs)) S.push(i);
      };
      app.sinks.add(cb);
      return () => app.sinks.delete(cb);
    })();
    const ok = await timedCapture({ prep: 3, duration: 4, cancel, onStart: () => (env.recorder.scene = 'dist_check'), onEnd: () => (env.recorder.scene = null) });
    stop();
    if (!ok) break;
    if (S.length < 8) {
      const r = await screen(t.distCheckName, [p(t.distFew, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
      if (r === 'cancel') break;
      continue;
    }
    const zm = median(S.map((x) => x.zs));
    const zi = median(S.map((x) => (x.sIris * x.f))); // по радужке, мм (для сравнения)
    const err = (zm / real - 1) * 100;
    const errIris = (zi / real - 1) * 100;
    const k = currentDistK(S[0].w, S[0].h);
    const nodes: Node[] = [
      h('p', { class: 'big' }, `${t.distCheckReal}: ${(real / 10).toFixed(1)} см · ${t.distCheckGot}: ${(zm / 10).toFixed(1)} см (${err >= 0 ? '+' : ''}${err.toFixed(1)} %)`),
      p(`${t.distCheckIris}: ${(zi / 10).toFixed(1)} см (${errIris >= 0 ? '+' : ''}${errIris.toFixed(1)} %). ${t.distCheckK}: ×${k.toFixed(3)}.`),
    ];
    if (Math.abs(err) > 15) nodes.push(p(t.distCheckBig, 'warn'));
    else if (Math.abs(err) <= 3) nodes.push(p(t.distCheckGood));
    const c = await screen(t.distCheckName, nodes, [
      { key: 'apply', label: t.distCheckApply, primary: Math.abs(err) > 3 },
      { key: 'again', label: t.distCheckAgain },
      { key: 'close', label: t.close, primary: Math.abs(err) <= 3 },
    ]);
    if (c === 'cancel' || c === 'close') break;
    if (c === 'apply') {
      setDistK(S[0].w, S[0].h, k * (real / zm));
      env.refresh();
      const d = await screen(t.distCheckName, [p(`${t.distCheckSaved}: ×${currentDistK(S[0].w, S[0].h).toFixed(3)}. ${t.distCheckHint}`, 'big')], [{ key: 'again', label: t.distCheckAgain, primary: true }, { key: 'close', label: t.close }]);
      if (d !== 'again') break;
    }
  }
  sheet.close();
}
