import test from 'node:test';
import assert from 'node:assert/strict';
import { BreakDetector, DET_DEFAULTS, DetEvent, DetSample, droppedTooMuch, thresholdFromNoise } from '../src/core/breakDetector';
import { rng } from './synth';

const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const DT = 140; // ≈ 7 кадров/с, как на Redmi 13

function run(det: BreakDetector, samples: DetSample[]): DetEvent[] {
  const ev: DetEvent[] = [];
  for (const s of samples) {
    const e = det.push(s);
    if (e) ev.push(e);
  }
  return ev;
}

test('в покое с шумом 1,3° ложных срывов нет (5000 кадров)', () => {
  const r = rng(1);
  const det = new BreakDetector();
  const s: DetSample[] = Array.from({ length: 5000 }, (_, i) => ({ t: i * DT, value: 1.3 * gauss(r), valid: true, z: 400 }));
  assert.equal(run(det, s).length, 0);
});

test('срыв на 9°: найден за < 0,8 с, дистанция берётся с первого кадра выше порога; возврат найден', () => {
  const r = rng(2);
  const det = new BreakDetector();
  const s: DetSample[] = [];
  for (let i = 0; i < 200; i++) {
    const broken = i >= 50 && i < 120;
    // дистанция растёт: 300 мм → 300 + 3·i
    s.push({ t: i * DT, value: (broken ? 9 : 0) + 1.3 * gauss(r), valid: true, z: 300 + 3 * i });
  }
  const ev = run(det, s);
  assert.deepEqual(ev.map((e) => e.type), ['break', 'return']);
  const b = ev[0];
  assert.equal(b.sign, 1);
  assert.ok(b.t - 50 * DT < 800, `задержка ${b.t - 50 * DT} мс`);
  assert.ok(Math.abs(b.onsetT - 50 * DT) <= 2 * DT, `onset ${b.onsetT}`);
  assert.ok(Math.abs(b.z - (300 + 3 * 50)) <= 3 * 3, `z срыва ${b.z}`);
  assert.ok(b.peak >= 8);
  assert.ok(ev[1].t - 120 * DT < 1500, `возврат: ${ev[1].t - 120 * DT} мс`);
});

test('срыв в сторону разведения (−9°) даёт знак −1', () => {
  const det = new BreakDetector();
  const s: DetSample[] = Array.from({ length: 80 }, (_, i) => ({ t: i * DT, value: i >= 30 ? -9 : 0, valid: true, z: 400 }));
  assert.equal(run(det, s)[0].sign, -1);
});

test('моргания с выбросами не вызывают срыв, невалидные кадры не считаются', () => {
  const det = new BreakDetector();
  const s: DetSample[] = [];
  for (let i = 0; i < 400; i++) {
    const blink = i % 25 < 3; // 3 кадра на каждые 25
    s.push({ t: i * DT, value: blink ? 25 : 0, valid: !blink, z: 400 });
  }
  assert.equal(run(det, s).length, 0);
});

test('короткий всплеск (1–2 кадра) срывом не считается', () => {
  const det = new BreakDetector();
  const s: DetSample[] = Array.from({ length: 100 }, (_, i) => ({ t: i * DT, value: i === 40 || i === 41 ? 12 : 0, valid: true, z: 400 }));
  assert.equal(run(det, s).length, 0);
});

test('порог: не меньше 3° и не меньше 3σ шума', () => {
  const r = rng(3);
  const calm = Array.from({ length: 300 }, () => 0.4 * gauss(r));
  assert.equal(thresholdFromNoise(calm).threshold, DET_DEFAULTS.thresholdDeg);
  const noisy = Array.from({ length: 300 }, () => 3 * gauss(r));
  const t = thresholdFromNoise(noisy);
  assert.ok(t.threshold > 3 && Math.abs(t.threshold - 3 * t.sigma) < 1e-9, `T=${t.threshold}`);
});

test('стоп-условие: результат упал более чем на 30 % от первых трёх', () => {
  assert.equal(droppedTooMuch([40, 42, 38]), false);
  assert.equal(droppedTooMuch([40, 42, 38, 25]), true);
  assert.equal(droppedTooMuch([40, 42, 38, 35]), false);
});
