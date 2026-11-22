// Мастер калибровки: размер радужки → модель лица → ноль. Что-то уже сделанное можно пропустить.
import { cardPose, cardWarning, irisMmFromCard } from './core/card';
import { FaceModelBuilder, RIGID_IDX, toMm } from './core/faceModel';
import { median, std, windowStat } from './core/filters';
import { DEFAULT_IRIS_MM, focalFromVerticalFov, isPlausibleIris } from './core/scale';
import type { CardMarker } from './cardMark';
import { t } from './i18n';
import type { Recorder } from './recorder';
import { DEFAULT_FOV, FrameInfo, app, applyIris, applyModel, currentFov, zeroValid } from './state';
import { DET_DEFAULTS, thresholdFromNoise } from './core/breakDetector';
import { Cancel, h, sheet, sleep, timedCapture } from './ui';
import { stepDistance, stepRefine } from './precise';

export interface Env {
  ensureCamera(): Promise<boolean>;
  freezeFrame(): HTMLCanvasElement | null;
  marker: CardMarker;
  recorder: Recorder;
  refresh(): void;
}

interface Btn {
  key: string;
  label: string;
  primary?: boolean;
}

const p = (text: string, cls = '') => h('p', { class: cls }, text);
const why = (text: string) => h('p', { class: 'why' }, text);
const fmtDate = (ms: number) => new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { timeStyle: 'short' });
const sg = (x: number, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);

function collect(cb: (i: FrameInfo) => void): () => void {
  app.sinks.add(cb);
  return () => app.sinks.delete(cb);
}

export async function runCalibration(env: Env): Promise<void> {
  const cancel = new Cancel();
  sheet.open(() => {
    cancel.cancel();
    env.marker.stop();
    env.recorder.scene = null;
  });
  env.recorder.clear(); // каждая новая калибровка пишется с нуля

  const screen = (title: string, nodes: (Node | null | false)[], btns: Btn[]): Promise<string> =>
    new Promise((resolve) => {
      const row = h('div', { class: 'btnrow' }, ...btns.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => resolve(b.key) }, b.label)));
      sheet.set(title, ...nodes, row);
      void cancel.promise.then(() => resolve('cancel'));
    });
  const info = (title: string, ...nodes: Node[]) => sheet.set(title, ...nodes);

  if (!(await env.ensureCamera())) {
    sheet.set(t.wizardStep(1, t.s1Name), p(t.needCamera));
    return;
  }

  for (let k = 0; k < 30 && !app.lastInfo; k++) await sleep(100); // нужен размер кадра для проверки записанных значений

  // ---------------- шаг 1: размер радужки ----------------
  const title1 = t.wizardStep(1, t.s1Name);

  async function cardFlow(): Promise<'saved' | 'back' | 'cancel'> {
    for (;;) {
      const a = await screen(title1, [why(t.s1Why), p(t.s1CardHow)], [{ key: 'go', label: t.start2, primary: true }, { key: 'back', label: t.back }]);
      if (a === 'cancel') return 'cancel';
      if (a === 'back') return 'back';

      info(title1, p(t.s1CardWait, 'big'));
      const px: number[] = [];
      const stop = collect((i) => {
        if (i.face && i.open > 0.25 && Number.isFinite(i.irisPx)) px.push(i.irisPx);
      });
      const ok = await timedCapture({ prep: 3, duration: 3, cancel, onStart: () => (env.recorder.scene = 'iris_card'), onEnd: () => (env.recorder.scene = null) });
      stop();
      if (!ok) return 'cancel';
      const frozen = env.freezeFrame();
      if (!frozen || px.length < 6) {
        const r = await screen(title1, [p(t.s1CardFew)], [{ key: 'retry', label: t.redo, primary: true }, { key: 'back', label: t.back }]);
        if (r === 'cancel') return 'cancel';
        if (r === 'back') return 'back';
        continue;
      }
      const irisPx = median(px);

      env.marker.start(frozen);
      retake: for (;;) {
        const b = await screen(title1, [p(t.s1CardMark)], [{ key: 'calc', label: t.s1CardCalc, primary: true }, { key: 'retake', label: t.retake }]);
        if (b === 'cancel') {
          env.marker.stop();
          return 'cancel';
        }
        if (b === 'retake') {
          env.marker.stop();
          break retake;
        }
        for (;;) {
          let mm = NaN;
          let warn: ReturnType<typeof cardWarning> = null;
          try {
            const f = focalFromVerticalFov(frozen.height, currentFov(frozen.width, frozen.height));
            const pose = cardPose(env.marker.corners, { f, cx: frozen.width / 2, cy: frozen.height / 2 });
            mm = irisMmFromCard(irisPx, pose);
            warn = cardWarning(pose);
          } catch {
            warn = 'corners';
          }
          const good = Number.isFinite(mm) && isPlausibleIris(mm) && warn !== 'corners';
          const nodes: Node[] = [];
          if (Number.isFinite(mm)) nodes.push(h('p', { class: 'big' }, `${t.s1Result}: ${mm.toFixed(2)} мм`));
          if (warn === 'corners') nodes.push(p(t.s1CardCorners, 'warn'));
          else if (Number.isFinite(mm) && !isPlausibleIris(mm)) nodes.push(p(t.s1CardBad, 'warn'));
          if (warn === 'tilt') nodes.push(p(t.s1CardTilt, 'warn'));
          const btns: Btn[] = good
            ? [{ key: 'save', label: t.save, primary: true }, { key: 'fix', label: t.s1CardFix }, { key: 'retake', label: t.retake }]
            : [{ key: 'fix', label: t.s1CardFix, primary: true }, { key: 'retake', label: t.retake }];
          const c = await screen(title1, nodes, btns);
          if (c === 'cancel') {
            env.marker.stop();
            return 'cancel';
          }
          if (c === 'save') {
            env.marker.stop();
            applyIris(mm, 'card');
            env.refresh();
            return 'saved';
          }
          if (c === 'retake') {
            env.marker.stop();
            break retake;
          }
          // 'fix': вернуться к отметке углов
          break;
        }
      }
    }
  }

  async function stepIris(): Promise<boolean> {
    if (app.irisAt) {
      const a = await screen(
        title1,
        [why(t.s1Why), p(`${t.s1Saved}: ${app.iris.irisMm.toFixed(2)} мм (${t.methodNames[app.iris.method]}, ${fmtDate(app.irisAt)}).`, 'big')],
        [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }],
      );
      if (a === 'cancel') return false;
      if (a === 'skip') return true;
    }
    for (;;) {
      const m = await screen(title1, [why(t.s1Why), p(t.s1Pick)], [
        { key: 'card', label: t.s1Card, primary: true },
        { key: 'manual', label: t.s1Manual },
        { key: 'default', label: t.s1Default },
      ]);
      if (m === 'cancel') return false;
      if (m === 'default') {
        applyIris(DEFAULT_IRIS_MM, 'default');
        env.refresh();
        const d = await screen(title1, [p(`${t.s1Done}: ${DEFAULT_IRIS_MM.toFixed(1)} мм`, 'big')], [{ key: 'next', label: t.next, primary: true }]);
        return d !== 'cancel';
      }
      if (m === 'manual') {
        for (;;) {
          const input = h('input', { type: 'number', min: '9', max: '14', step: '0.1', value: app.iris.irisMm.toFixed(1) });
          const err = h('p', { class: 'warn' });
          const a = await screen(title1, [p(t.s1ManualHow), h('p', null, input, ' мм'), err], [{ key: 'save', label: t.save, primary: true }, { key: 'back', label: t.back }]);
          if (a === 'cancel') return false;
          if (a === 'back') break;
          const v = Number(input.value);
          if (!Number.isFinite(v) || v < 9 || v > 14) {
            sheet.set(title1, p(t.s1ManualBad, 'warn'));
            await new Promise((r) => setTimeout(r, 900));
            continue;
          }
          applyIris(v, 'manual');
          env.refresh();
          const d = await screen(title1, [p(`${t.s1Done}: ${v.toFixed(2)} мм`, 'big')], [{ key: 'next', label: t.next, primary: true }]);
          return d !== 'cancel';
        }
        continue;
      }
      const r = await cardFlow();
      if (r === 'cancel') return false;
      if (r === 'saved') {
        const d = await screen(title1, [p(`${t.s1Done}: ${app.iris.irisMm.toFixed(2)} мм`, 'big')], [{ key: 'next', label: t.next, primary: true }]);
        return d !== 'cancel';
      }
    }
  }

  // ---------------- шаг 2: модель лица ----------------
  const title2 = t.wizardStep(3, t.s2Name);
  async function stepModel(): Promise<boolean> {
    if (app.model) {
      const sameCam = !app.modelCamera || app.modelCamera === app.cameraKey;
      const fovNow = app.lastInfo ? currentFov(app.lastInfo.w, app.lastInfo.h) : DEFAULT_FOV;
      const fovChanged = Math.abs(fovNow - app.modelFov) > 5;
      const btns: Btn[] = sameCam && !fovChanged
        ? [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }]
        : [{ key: 'redo', label: t.redo, primary: true }, { key: 'skip', label: t.skip }];
      const a = await screen(
        title2,
        [why(t.s2Why), p(`${t.s2Saved} (${fmtDate(app.modelAt)}).`, 'big'), !sameCam && p(t.s2OtherCam, 'warn'), sameCam && fovChanged && p(t.s2OtherFov, 'warn')],
        btns,
      );
      if (a === 'cancel') return false;
      if (a === 'skip') return true;
    }
    for (;;) {
      const a = await screen(title2, [why(t.s2Why), p(t.s2How)], [{ key: 'go', label: t.start2, primary: true }]);
      if (a === 'cancel') return false;
      info(title2, p(t.s2Wait, 'big'));
      const builder = new FaceModelBuilder();
      const stop = collect((i) => {
        if (i.face && i.Rraw && i.lm) builder.add(toMm(i.lm, RIGID_IDX, i.w, i.h, i.sIris, i.f), i.Rraw);
      });
      const ok = await timedCapture({ prep: 3, duration: 10, cancel, onStart: () => (env.recorder.scene = 'face_model'), onEnd: () => (env.recorder.scene = null) });
      stop();
      if (!ok) return false;
      const m = builder.build();
      if (!m) {
        const r = await screen(title2, [p(t.s2Few, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
        if (r === 'cancel') return false;
        continue;
      }
      const good = m.poseVariationOk && m.spreadMm < 2;
      const nodes: Node[] = [
        h('p', { class: 'big' }, `${t.s2Result}: кадров ${m.frames}, разброс точек ${m.spreadMm.toFixed(2)} мм`),
        p(`Повороты головы: по горизонтали ${m.yawRangeDeg.toFixed(0)}°, по вертикали ${m.pitchRangeDeg.toFixed(0)}°.`),
      ];
      if (!m.poseVariationOk) nodes.push(p(t.s2Few2, 'warn'));
      if (m.spreadMm >= 2) nodes.push(p(t.s2Noisy, 'warn'));
      const btns: Btn[] = good
        ? [{ key: 'save', label: t.save, primary: true }, { key: 'redo', label: t.redo }]
        : [{ key: 'redo', label: t.redo, primary: true }, { key: 'save', label: t.s2Force }];
      const c = await screen(title2, nodes, btns);
      if (c === 'cancel') return false;
      if (c === 'save') {
        applyModel(m, app.lastInfo ? currentFov(app.lastInfo.w, app.lastInfo.h) : DEFAULT_FOV);
        env.refresh();
        return true;
      }
    }
  }

  // ---------------- шаг 3: ноль ----------------
  const title3 = t.wizardStep(4, t.s3Name);
  async function stepZero(): Promise<boolean> {
    if (zeroValid() && app.zero) {
      const z = app.zero;
      const a = await screen(
        title3,
        [why(t.s3Why), p(`${t.s3Saved} (${fmtTime(z.at)}): правый ${sg(z.R)}°, левый ${sg(z.L)}°, ${t.dist} ${(z.z / 10).toFixed(0)} см.`, 'big')],
        [{ key: 'skip', label: t.skip, primary: true }, { key: 'redo', label: t.redo }],
      );
      if (a === 'cancel') return false;
      if (a === 'skip') return true;
    }
    for (;;) {
      const a = await screen(title3, [why(t.s3Why), p(t.s3How)], [{ key: 'go', label: t.start2, primary: true }]);
      if (a === 'cancel') return false;
      info(title3, p(t.s3Wait, 'big'));
      const S: { angR: number; angL: number; open: number; z: number; ipd: number }[] = [];
      const stop = collect((i) => {
        if (i.face) S.push(i);
      });
      const ok = await timedCapture({ prep: 3, duration: 6, cancel, onStart: () => (env.recorder.scene = 'zero'), onEnd: () => (env.recorder.scene = null) });
      stop();
      if (!ok) return false;
      const open = S.map((s) => s.open);
      const stR = windowStat(S.map((s) => s.angR), open, 8);
      const stL = windowStat(S.map((s) => s.angL), open, 8);
      const stZ = windowStat(S.map((s) => s.z), open, 8);
      const stI = windowStat(S.map((s) => s.ipd), open, 8);
      if (!(stR.ok && stL.ok && stZ.ok)) {
        const r = await screen(title3, [p(t.s3Few, 'warn')], [{ key: 'retry', label: t.redo, primary: true }]);
        if (r === 'cancel') return false;
        continue;
      }
      const nodes: Node[] = [
        h('p', { class: 'big' }, `${t.s3Result}: правый ${sg(stR.median)}°, левый ${sg(stL.median)}°`),
        p(`${t.dist} ${(stZ.median / 10).toFixed(0)} см, надёжных кадров ${stR.n} из ${stR.total}.`),
      ];
      if (std(S.map((s) => s.angR)) > 1.5 || std(S.map((s) => s.angL)) > 1.5 || stR.std > 1.5 || stL.std > 1.5) nodes.push(p(t.s3Unstable, 'warn'));
      if (stZ.median < 250 || stZ.median > 700) nodes.push(p(t.s3Dist, 'warn'));
      const c = await screen(title3, nodes, [{ key: 'save', label: t.next, primary: true }, { key: 'redo', label: t.redo }]);
      if (c === 'cancel') return false;
      if (c === 'save') {
        const noise = thresholdFromNoise(S.map((x) => x.angR + x.angL), DET_DEFAULTS);
        app.zero = { R: stR.median, L: stL.median, z: stZ.median, ipd: stI.median, irisMm: app.iris.irisMm, sigma: noise.sigma, at: Date.now() };
        env.refresh();
        return true;
      }
    }
  }

  const ctx = { env, cancel, screen };
  if (!(await stepIris())) return;
  if (!(await stepDistance(ctx, t.wizardStep(2, t.distName)))) return; // до модели: поле зрения нужно для её построения
  if (!(await stepModel())) return;
  if (!(await stepZero())) return;
  if (!(await stepRefine(ctx, t.wizardStep(5, t.rfName)))) return;

  for (;;) {
    const a = await screen(t.doneTitle, [p(t.doneText)], [{ key: 'close', label: t.close, primary: true }, { key: 'csv', label: t.menuCsv }]);
    if (a === 'csv') env.recorder.download('calibration');
    else break;
  }
  sheet.close();
}
