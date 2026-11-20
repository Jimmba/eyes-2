import test from 'node:test';
import assert from 'node:assert/strict';
import { CAM, Gaze, fixate, render, rng } from './synth';
import { angleDeg, binocular, deviationDeg, expectedNasalDeg, eyeOffsetMm, interEyeMm, prismDiopters } from '../src/core/gaze';
import { median } from '../src/core/filters';

const A = (fr: ReturnType<typeof render>, side: 'right' | 'left', mode: '3d' | '2d' = '3d', f: number | undefined = CAM.f, sErr = 1) =>
  angleDeg(eyeOffsetMm(fr.lm, CAM.w, CAM.h, side, fr.s * sErr, mode === '3d' ? fr.Rimg : null, f).dxMm);

test('взгляд прямо: угол 0 при любой дистанции и повороте головы (перспективная поправка)', () => {
  const rnd = rng(1);
  for (const z of [300, 400, 600])
    for (const yaw of [0, 15, -15]) {
      const fr = render({ right: { nasal: 0 }, left: { nasal: 0 } }, { yaw, pitch: 0, roll: 0, zMm: z }, 0, rnd);
      assert.ok(Math.abs(A(fr, 'right')) < 0.05 && Math.abs(A(fr, 'left')) < 0.05);
    }
});

test('угол восстанавливается в диапазоне −20…+25° при повороте, наклоне и крене головы (без шума)', () => {
  const rnd = rng(2);
  let worst = 0;
  for (const nasal of [-20, -10, 0, 10, 25])
    for (const pose of [{ yaw: 0, pitch: 0, roll: 0 }, { yaw: 15, pitch: 10, roll: 8 }, { yaw: -12, pitch: -8, roll: -10 }]) {
      const fr = render({ right: { nasal }, left: { nasal: -nasal } }, { ...pose, zMm: 400 }, 0, rnd);
      worst = Math.max(worst, Math.abs(A(fr, 'right') - nasal), Math.abs(A(fr, 'left') + nasal));
    }
  assert.ok(worst < 0.3, `худшая ошибка ${worst.toFixed(2)}°`);
});

test('режим 2D даёт ошибку одного глаза от поворота головы, 3D нет; вергенция (сумма) устойчива и в 2D', () => {
  const rnd = rng(3);
  const g = { right: { nasal: 0 }, left: { nasal: 0 } };
  const f0 = render(g, { yaw: 0, pitch: 0, roll: 0, zMm: 400 }, 0, rnd);
  const f15 = render(g, { yaw: 15, pitch: 0, roll: 0, zMm: 400 }, 0, rnd);
  assert.ok(Math.abs(A(f15, 'right', '2d', undefined) - A(f0, 'right', '2d', undefined)) > 5);
  assert.ok(Math.abs(A(f15, 'right', '3d')) < 0.05);
  const sum = (fr: typeof f0) => A(fr, 'right', '2d', undefined) + A(fr, 'left', '2d', undefined);
  assert.ok(Math.abs(sum(f15) - sum(f0)) < 1);
});

test('межуголковое расстояние не зависит от сведения глаз', () => {
  const rnd = rng(4);
  const a = render(fixate(300), { yaw: 5, pitch: 0, roll: 0, zMm: 300 }, 0, rnd);
  const b = render({ right: { nasal: 0 }, left: { nasal: 0 } }, { yaw: 5, pitch: 0, roll: 0, zMm: 300 }, 0, rnd);
  assert.ok(Math.abs(interEyeMm(a.lm, CAM.w, CAM.h, a.s, CAM.f) - 62) < 0.1);
  assert.ok(Math.abs(interEyeMm(a.lm, CAM.w, CAM.h, a.s, CAM.f) - interEyeMm(b.lm, CAM.w, CAM.h, b.s, CAM.f)) < 0.01);
});

test('ожидаемое сведение и ПД', () => {
  assert.ok(Math.abs(expectedNasalDeg(62, 400) - 4.43) < 0.01);
  assert.ok(Math.abs(prismDiopters(1) - 1.7455) < 0.001);
  assert.ok(Math.abs(prismDiopters(9) - 15.84) < 0.01);
  assert.deepEqual(binocular(9, 0), { vergenceDeg: 9, versionDeg: 4.5 });
});

function measure(g: Gaze, z: number, n: number, noisePx: number, zNoise: number, seed: number, yaw = 0) {
  const rnd = rng(seed);
  const R: number[] = [], L: number[] = [];
  for (let k = 0; k < n; k++) {
    const fr = render(g, { yaw, pitch: 3, roll: 2, zMm: z }, noisePx, rnd, CAM, zNoise);
    R.push(A(fr, 'right'));
    L.push(A(fr, 'left'));
  }
  return { R: median(R), L: median(L), ipd: 62 };
}

test('срыв правого глаза на 9° к носу виден как вергенция ≈ +9° (15,8 ПД), левый не изменился', () => {
  const zero = measure(fixate(400), 400, 30, 0.4, 2, 10);
  const dev = measure({ right: { nasal: fixate(400).right.nasal + 9 }, left: { nasal: fixate(400).left.nasal } }, 400, 30, 0.4, 2, 11);
  const dR = deviationDeg(dev.R, zero.R, 400, 400, 62);
  const dL = deviationDeg(dev.L, zero.L, 400, 400, 62);
  assert.ok(Math.abs(dR - 9) < 1, `R ${dR.toFixed(2)}`);
  assert.ok(Math.abs(dL) < 1, `L ${dL.toFixed(2)}`);
  assert.ok(Math.abs(binocular(dR, dL).vergenceDeg - 9) < 1.2);
});

test('смена дистанции фиксации (ноль на 40 см, взгляд на 60 и 30 см) не даёт ложного отклонения', () => {
  const zero = measure(fixate(400), 400, 30, 0.4, 2, 20);
  for (const z of [300, 600]) {
    const m = measure(fixate(z), z, 30, 0.4, 2, 21 + z);
    const v = binocular(deviationDeg(m.R, zero.R, z, 400, 62), deviationDeg(m.L, zero.L, z, 400, 62)).vergenceDeg;
    assert.ok(Math.abs(v) < 1.2, `z=${z}: вергенция ${v.toFixed(2)}°`);
  }
});

test('шум: СКО одного кадра и медианы за 30 кадров (σ = 0,4 px, 2 мм по z)', () => {
  const rnd = rng(30);
  const one: number[] = [];
  for (let k = 0; k < 200; k++) one.push(A(render(fixate(400), { yaw: 0, pitch: 0, roll: 0, zMm: 400 }, 0.4, rnd, CAM, 2), 'right'));
  const m = one.reduce((a, b) => a + b, 0) / one.length;
  const sd = Math.sqrt(one.reduce((a, b) => a + (b - m) ** 2, 0) / (one.length - 1));
  assert.ok(sd < 1.5, `СКО кадра ${sd.toFixed(2)}°`);
  const meds: number[] = [];
  for (let k = 0; k < 40; k++) meds.push(measure(fixate(400), 400, 30, 0.4, 2, 100 + k).R);
  const mm = meds.reduce((a, b) => a + b, 0) / meds.length;
  const sdm = Math.sqrt(meds.reduce((a, b) => a + (b - mm) ** 2, 0) / (meds.length - 1));
  assert.ok(sdm < 0.5, `СКО медианы ${sdm.toFixed(2)}°`);
});

test('ошибка масштаба на 5 % и фокусного расстояния на 15 % дают небольшую ошибку угла', () => {
  const rnd = rng(40);
  const fr = render({ right: { nasal: 10 }, left: { nasal: 0 } }, { yaw: 10, pitch: 0, roll: 0, zMm: 400 }, 0, rnd);
  const ok = A(fr, 'right');
  const bad = A(fr, 'right', '3d', CAM.f * 1.15, 1.05);
  assert.ok(Math.abs(bad - ok) < 1.5, `Δ ${Math.abs(bad - ok).toFixed(2)}°`);
});
