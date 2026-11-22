import test from 'node:test';
import assert from 'node:assert/strict';
import { CAM, EYE_R, Gaze, render, rng } from './synth';
import { angleDeg, cornersMidCam, eyeOffsetMm } from '../src/core/gaze';
import { combineGains, fitGain } from '../src/core/eyeFit';
import { ScreenSpec, eyeCenterCam, mmPerCssPxFromCard, mmPerCssPxFromDiagonal, screenToCam, trueGazeDeg } from '../src/core/screenGeom';
import { V3, add, eulerToR, mv } from '../src/core/linalg';
import { fovFromFocal, focalFromKnownDistance, focalFromVerticalFov, isPlausibleFov } from '../src/core/scale';

const SPEC: ScreenSpec = { mmPerCssPx: 0.159, widthCss: 393, heightCss: 851, camOffsetMm: 4 };
const HEAD_EYE: Record<'right' | 'left', V3> = { right: [-31, -5, 10], left: [31, -5, 10] };

test('камера на центре верхнего края: фиксация камеры даёт ожидаемое сведение, точка справа от пользователя даёт поворот вправо', () => {
  const R = eulerToR(0, 0, 0);
  const eyeR = add(mv(R, HEAD_EYE.right), [0, 0, 400]);
  const eyeL = add(mv(R, HEAD_EYE.left), [0, 0, 400]);
  const cam: V3 = [0, 0, 0];
  const gR = trueGazeDeg(eyeR, cam, R, 'right');
  const gL = trueGazeDeg(eyeL, cam, R, 'left');
  assert.ok(Math.abs(gR.h - 4.32) < 0.05 && Math.abs(gL.h - 4.32) < 0.05, `${gR.h} ${gL.h}`); // atan(31/410)
  // точка на правом краю экрана (для пользователя): правый глаз идёт от носа (h < 4.4), левый к носу (h > 4.4)
  const right = screenToCam(SPEC.widthCss, 100, SPEC);
  assert.ok(trueGazeDeg(eyeR, right, R, 'right').h < gR.h);
  assert.ok(trueGazeDeg(eyeL, right, R, 'left').h > gL.h);
  // точка ниже камеры: взгляд вниз (v < 0)
  assert.ok(trueGazeDeg(eyeR, screenToCam(SPEC.widthCss / 2, 700, SPEC), R, 'right').v < -10);
});

const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const varOf = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); };

function gridPairs(k: number, noise: number, seed: number, z = 380, frames = 12) {
  const rnd = rng(seed);
  const pose = { yaw: 3, pitch: 5, roll: 1, zMm: z };
  const Rh = eulerToR(pose.yaw, pose.pitch, pose.roll);
  const out: Record<'right' | 'left', { mh: number[]; th: number[]; mv: number[]; tv: number[]; varH: number }> = {
    right: { mh: [], th: [], mv: [], tv: [], varH: 0 },
    left: { mh: [], th: [], mv: [], tv: [], varH: 0 },
  };
  const vars: Record<'right' | 'left', number[]> = { right: [], left: [] };
  for (const fy of [0.12, 0.5, 0.88])
    for (const fx of [0.12, 0.5, 0.88]) {
      const target = screenToCam(fx * SPEC.widthCss, fy * SPEC.heightCss, SPEC);
      for (const side of ['right', 'left'] as const) {
        // что рисуем: реальный поворот глаза (k_true: измеренный угол = истинный / k)
        const eyeTrue = add(mv(Rh, HEAD_EYE[side]), [0, 0, z]);
        const g = trueGazeDeg(eyeTrue, target, Rh, side);
        const gz: Gaze = { right: { nasal: 0 }, left: { nasal: 0 } };
        gz[side] = { nasal: g.h / k, up: g.v / k };
        const H: number[] = [], T: number[] = [], V: number[] = [], TV: number[] = [];
        for (let q = 0; q < frames; q++) {
          const fr = render(gz, pose, noise, rnd, CAM, 0.8);
          const off = eyeOffsetMm(fr.lm, CAM.w, CAM.h, side, fr.s, fr.Rimg, CAM.f);
          // «истина» по оценке пайплайна (положение глаза из ландмарок)
          const eye = eyeCenterCam(cornersMidCam(fr.lm, CAM.w, CAM.h, side, fr.s, CAM.f), fr.Rimg);
          const tg = trueGazeDeg(eye, target, fr.Rimg, side);
          H.push(angleDeg(off.dxMm, EYE_R));
          T.push(tg.h);
          V.push(angleDeg(off.dyMm, EYE_R));
          TV.push(tg.v);
        }
        out[side].mh.push(med(H));
        out[side].th.push(med(T));
        out[side].mv.push(med(V));
        out[side].tv.push(med(TV));
        vars[side].push((varOf(H) / frames) * 1.57); // дисперсия медианы
      }
    }
  for (const side of ['right', 'left'] as const) out[side].varH = vars[side].reduce((a, b) => a + b, 0) / vars[side].length;
  return out;
}

test('сетка 3×3: при реальной геометрии коэффициент по горизонтали ≈ 1', () => {
  const o = gridPairs(1, 0.3, 1);
  for (const side of ['right', 'left'] as const) {
    const f = fitGain(o[side].mh, o[side].th, o[side].varH);
    assert.ok(f.ok, `${side} ok`);
    assert.ok(Math.abs(f.k - 1) < 0.08, `${side} k=${f.k.toFixed(3)} r2=${f.r2.toFixed(3)} rms=${f.rms.toFixed(2)}`);
    assert.ok(f.rangeDeg > 5 && f.rangeDeg < 10, `диапазон ${f.rangeDeg.toFixed(1)}°`); // узкий экран телефона в портрете: ≈ 7°, поэтому в мастере есть предупреждение
  }
});

test('сетка 3×3: завышение измеренного угла в 1,43 раза (как в логе M1) даёт k ≈ 0,7', () => {
  const o = gridPairs(0.7, 0.3, 2);
  for (const side of ['right', 'left'] as const) {
    const f = fitGain(o[side].mh, o[side].th, o[side].varH);
    assert.ok(Math.abs(f.k - 0.7) < 0.06, `${side} k=${f.k.toFixed(3)}`);
  }
});

test('вертикальный коэффициент подгоняется, но с большим разбросом', () => {
  const o = gridPairs(1, 0.3, 3);
  const f = fitGain(o.right.mv, o.right.tv);
  assert.ok(Math.abs(f.k - 1) < 0.15, `kv=${f.k.toFixed(3)} r2=${f.r2.toFixed(3)}`);
});

test('подгонка: точная прямая, малый диапазон, комбинирование дистанций', () => {
  const x = [-8, -4, 0, 4, 8, 12, -12, 2];
  const f = fitGain(x, x.map((v) => 0.7 * v + 2));
  assert.ok(Math.abs(f.k - 0.7) < 1e-9 && Math.abs(f.b - 2) < 1e-9 && f.ok);
  assert.equal(fitGain([0, 0.1, 0.2, 0.3, 0.4, 0.5], [0, 0.1, 0.2, 0.3, 0.4, 0.5]).ok, false); // диапазон < 3°
  assert.equal(fitGain(x, x.map((v) => -v)).ok, false); // отрицательный наклон
  const c = combineGains([fitGain(x, x.map((v) => 0.7 * v)), fitGain(x, x.map((v) => 0.8 * v))]);
  assert.ok(c && Math.abs(c.k - 0.75) < 1e-9 && Math.abs(c.spread - 0.1 / 0.75) < 1e-9);
  assert.equal(combineGains([fitGain([1], [1])]), null);
});

test('размер пикселя экрана: по карте и по диагонали', () => {
  assert.ok(Math.abs(mmPerCssPxFromCard(538) - 0.1591) < 0.001);
  // Redmi 13: 6,79″, экран в CSS px 393×851 → ≈ 0,18 мм
  assert.ok(Math.abs(mmPerCssPxFromDiagonal(6.79, 393, 851) - 0.1840) < 0.002);
});

test('поле зрения по известной дистанции: фокусное → FOV и обратно', () => {
  const f = focalFromKnownDistance(60, 11.7, 400);
  const fov = fovFromFocal(1920, f);
  assert.ok(Math.abs(focalFromVerticalFov(1920, fov) - f) < 1e-6);
  assert.ok(isPlausibleFov(63) && !isPlausibleFov(20) && !isPlausibleFov(140));
});

test('поправка на шум: одиночные кадры занижают k, поправка возвращает его к 1', () => {
  const o = gridPairs(1, 0.3, 4, 380, 1);
  const raw = fitGain(o.right.mh, o.right.th);
  const fixed = fitGain(o.right.mh, o.right.th, 0.5 * 0.5 * 1.57);
  assert.ok(raw.k < 0.97, `без поправки ${raw.k.toFixed(3)}`);
  assert.ok(Math.abs(fixed.k - 1) < Math.abs(raw.k - 1), `с поправкой ${fixed.k.toFixed(3)}`);
});
