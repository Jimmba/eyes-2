import test from 'node:test';
import assert from 'node:assert/strict';
import { CAM, RIGID_XYZ, fixate, render, rng } from './synth';
import { FaceModelBuilder, RIGID_IDX, fitScale, toMm } from '../src/core/faceModel';
import { irisDiamPx } from '../src/core/gaze';

const Z = 400;
const irisAvg = (fr: ReturnType<typeof render>) => (irisDiamPx(fr.lm, CAM.w, CAM.h, 'right') + irisDiamPx(fr.lm, CAM.w, CAM.h, 'left')) / 2;

function build(conv: 'C·R·C' | 'C·Rᵀ·C' | 'R' | 'Rᵀ', seed: number, yawAmp = 40, pitchAmp = 30) {
  const rnd = rng(seed);
  const b = new FaceModelBuilder();
  for (let k = 0; k < 80; k++) {
    const p = { yaw: (rnd() - 0.5) * yawAmp, pitch: (rnd() - 0.5) * pitchAmp, roll: (rnd() - 0.5) * 20, zMm: Z + (rnd() - 0.5) * 100 };
    const fr = render(fixate(Z), p, 0.3, rnd);
    b.add(toMm(fr.lm, RIGID_IDX, CAM.w, CAM.h, 11.7 / irisAvg(fr), CAM.f), fr.Rraw(conv));
  }
  return b.build()!;
}

for (const conv of ['C·R·C', 'C·Rᵀ·C', 'R', 'Rᵀ'] as const) {
  test(`модель лица сама находит конвенцию позы: ${conv}`, () => {
    const m = build(conv, 11);
    assert.equal(m.convention, conv);
    assert.ok(m.spreadMm < 1, `разброс ${m.spreadMm}`);
    assert.ok(m.poseVariationOk);
    // модель совпадает с истинной геометрией (относительно центроида) в пределах ~1 мм
    const truth = RIGID_IDX.map((i) => RIGID_XYZ[i]);
    const c = [0, 1, 2].map((k) => truth.reduce((a, p) => a + p[k], 0) / truth.length);
    let worst = 0;
    truth.forEach((p, i) => {
      const d = Math.hypot(p[0] - c[0] - m.points[i][0], p[1] - c[1] - m.points[i][1], p[2] - c[2] - m.points[i][2]);
      worst = Math.max(worst, d);
    });
    assert.ok(worst < 1.5, `макс. ошибка точки ${worst.toFixed(2)} мм`);
  });
}

test('мало поворотов головы → предупреждение, мало кадров → null', () => {
  const m = build('C·R·C', 5, 3, 3);
  assert.equal(m.poseVariationOk, false);
  const b = new FaceModelBuilder();
  assert.equal(b.build(), null);
});

test('масштаб кадра по модели (перспективная подгонка): ошибка не больше 3 % на 30–60 см при повороте до 15°', () => {
  const model = build('C·R·C', 21);
  const rnd = rng(3);
  let worst = 0;
  for (const z of [300, 400, 600])
    for (const yaw of [-15, 0, 15]) {
      const fr = render(fixate(z), { yaw, pitch: 5, roll: 3, zMm: z }, 0, rnd);
      const pts = RIGID_IDX.map((i) => ({ x: fr.lm[i].x * CAM.w, y: fr.lm[i].y * CAM.h }));
      const e = Math.abs(fitScale(model.points, fr.Rimg, pts, { f: CAM.f, cx: CAM.w / 2, cy: CAM.h / 2 }).mmPerPx / fr.s - 1);
      worst = Math.max(worst, e);
    }
  assert.ok(worst < 0.03, `худшая ошибка ${(worst * 100).toFixed(2)} %`);
});

test('мм на пиксель по модели не зависит от ошибки f (на 15 %) и устойчив к шуму точек (σ = 0,4 px)', () => {
  const model = build('C·R·C', 22);
  const rnd = rng(9);
  const errs: number[] = [];
  for (let k = 0; k < 30; k++) {
    const fr = render(fixate(400), { yaw: 8, pitch: 4, roll: 2, zMm: 400 }, 0.4, rnd);
    const pts = RIGID_IDX.map((i) => ({ x: fr.lm[i].x * CAM.w, y: fr.lm[i].y * CAM.h }));
    const r = fitScale(model.points, fr.Rimg, pts, { f: CAM.f * 1.15, cx: CAM.w / 2, cy: CAM.h / 2 });
    errs.push(r.mmPerPx / fr.s - 1); // Z/f инвариантно к ошибке f: ошибается только абсолютное расстояние, не мм/px
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(Math.abs(mean) < 0.04, `смещение ${(mean * 100).toFixed(1)} %`);
});
