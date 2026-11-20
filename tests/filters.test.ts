import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuro, TimeWindow, blinkMask, median, std, windowStat } from '../src/core/filters';

test('median и std', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.ok(Math.abs(std([1, 2, 3]) - 1) < 1e-12);
});

test('моргание исключается вместе с 3 кадрами вокруг', () => {
  const open = Array(20).fill(0.38);
  open[10] = 0.05;
  const m = blinkMask(open);
  m.forEach((bad, i) => assert.equal(bad, i >= 7 && i <= 13, `кадр ${i}`));
});

test('медленное закрытие век (взгляд вниз) относительно медианы окна не считается морганием', () => {
  const open = Array(30).fill(0.26);
  assert.ok(blinkMask(open).every((b) => !b));
});

test('окно: валидно при ≥70 % хороших кадров', () => {
  const v = Array(20).fill(5);
  const open = Array(20).fill(0.38);
  assert.equal(windowStat(v, open).ok, true);
  for (const i of [3, 4, 5, 12, 13, 14, 15]) open[i] = 0.02; // 2 моргания → исключено 14 кадров из 20
  const s = windowStat(v, open);
  assert.equal(s.ok, false);
  assert.ok(s.validFraction < 0.7);
});

test('TimeWindow хранит только последние spanMs', () => {
  const w = new TimeWindow<{ t: number }>(1000);
  for (let t = 0; t <= 3000; t += 100) w.push({ t });
  assert.equal(w.items[0].t, 2000);
});

test('One Euro: шум в покое уменьшается, ступенька отслеживается', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const f = new OneEuro();
  const raw: number[] = [], out: number[] = [];
  for (let i = 0; i < 300; i++) {
    const x = 1 + rnd();
    raw.push(x);
    out.push(f.filter(x, i * 33));
  }
  assert.ok(std(out.slice(60)) < 0.6 * std(raw.slice(60)));
  const g = new OneEuro();
  let y = 0;
  for (let i = 0; i < 90; i++) y = g.filter(i < 15 ? 0 : 10, i * 33);
  assert.ok(Math.abs(y - 10) < 0.5, `после ступеньки ${y}`);
});
