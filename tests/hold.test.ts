import test from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_DEFAULTS, HoldController } from '../src/core/hold';

const mk = (dir: 1 | -1, b: number, r: number) => new HoldController({ dir, breakCm: b, returnCm: r, ...HOLD_DEFAULTS });
/** Прокручивает время: z постоянна, шаг 100 мс. */
function run(c: HoldController, t0: number, sec: number, z: number, face = true): number {
  let t = t0;
  for (let i = 0; i < sec * 10; i++) {
    t += 100;
    c.tick(t, z, face);
  }
  return t;
}

test('старт: цель на 5 % ближе срыва, но в зоне между возвратом и срывом', () => {
  const c = mk(1, 40, 34);
  assert.equal(c.H0, 38);
  assert.equal(c.H, 38);
  // возврат ближе, чем 95 % срыва: берётся 95 %; возврат дальше: берётся возврат
  assert.equal(mk(1, 40, 39.5).H0, 39.5);
  assert.equal(mk(1, 40, NaN).H0, 38);
});

/** Крутит время, пока не выполнится условие (или не пройдёт maxSec). */
function until(c: HoldController, t0: number, z: () => number, pred: () => boolean, maxSec = 60): number {
  let t = t0;
  for (let i = 0; i < maxSec * 10 && !pred(); i++) {
    t += 100;
    c.tick(t, z(), true);
  }
  return t;
}

test('вход в полосу 1 с, затем удержание; успех через 20 с даёт ступень вверх', () => {
  const c = mk(1, 40, 34);
  let t = run(c, 0, 0.5, 38);
  assert.equal(c.phase, 'enter');
  t = until(c, t, () => 38, () => c.phase === 'hold', 3);
  assert.equal(c.phase, 'hold');
  const tHold = t;
  t = until(c, t, () => 38, () => c.ups === 1, 30);
  assert.ok(t - tHold >= 19900 && t - tHold <= 20300, `прошло ${t - tHold} мс`);
  assert.equal(c.phase, 'up');
  assert.equal(c.H, 40);
  assert.equal(c.bestHoldCm, 38);
  t = until(c, t, () => 40, () => c.phase === 'enter', 5);
  assert.equal(c.phase, 'enter');
});

test('слишком близко: время не засчитывается, команда «чуть дальше»', () => {
  const c = mk(1, 40, 34);
  let t = run(c, 0, 1.2, 38);
  assert.equal(c.phase, 'hold');
  t = run(c, t, 10, 30); // далеко на лёгкой стороне
  assert.ok(c.holdSec < 1, `hold ${c.holdSec}`);
  assert.deepEqual(c.command(true, 30), { key: 'farther', style: 'near' });
  run(c, t, 1, 46);
  assert.deepEqual(c.command(true, 46), { key: 'closer', style: 'warn' });
});

test('срыв: recover до возврата; касание и камера равноправны', () => {
  const c = mk(1, 40, 34);
  let t = run(c, 0, 1.2, 38);
  assert.ok(c.onBreak(41, t, 'camera'));
  assert.equal(c.phase, 'recover');
  assert.ok(!c.onBreak(41, t, 'tap'), 'второй срыв в recover игнорируется');
  assert.ok(c.onReturn(36, t, 'camera'));
  assert.ok(!c.onReturn(36, t, 'camera'), 'возврат вне recover игнорируется');
  assert.equal(c.phase, 'enter');
  assert.equal(c.breaks.length, 1);
  assert.equal(c.returns[0].cm, 36);
});

test('два ранних срыва подряд: ступень вниз', () => {
  const c = mk(1, 40, 34);
  let t = run(c, 0, 1.2, 38);
  c.onBreak(40, t, 'camera');
  c.onReturn(37, t, 'camera');
  t = run(c, t, 1.2, 38);
  c.onBreak(40, t, 'tap');
  c.onReturn(37, t, 'tap');
  assert.equal(c.phase, 'down');
  assert.equal(c.downs, 1);
  assert.equal(c.H, 36);
});

test('поздний срыв не считается ранним', () => {
  const c = mk(1, 40, 34);
  let t = run(c, 0, 1.2, 38);
  t = run(c, t, 12, 38);
  c.onBreak(40, t, 'camera');
  c.onReturn(37, t, 'camera');
  t = run(c, t, 1.2, 38);
  c.onBreak(40, t, 'camera');
  c.onReturn(37, t, 'camera');
  assert.equal(c.downs, 0);
});

test('лицо потеряно: время ступени не идёт', () => {
  const c = mk(1, 40, 34);
  let t = run(c, 0, 1.2, 38);
  t = run(c, t, 5, 38);
  const h = c.holdSec;
  t = run(c, t, 5, 38, false);
  assert.ok(Math.abs(c.holdSec - h) < 0.01);
  assert.deepEqual(c.command(false, 38), { key: 'face', style: 'idle' });
});

test('общее время: по истечении упражнение заканчивается', () => {
  const c = new HoldController({ dir: 1, breakCm: 40, returnCm: 34, totalSec: 5, successSec: 20 });
  run(c, 0, 6, 38);
  assert.equal(c.phase, 'done');
  assert.equal(c.stop, 'time');
});

test('на лёгком пределе три срыва за 30 с: остановка по правилу', () => {
  const c = mk(1, 40, 34);
  // hEasy = max(15, 0.9·34) = 30,6; опустим цель до предела вручную через серию «ступеней вниз»
  c.H = c.hEasy;
  let t = 0;
  for (let i = 0; i < 3; i++) {
    t += 1000;
    c.onBreak(c.H, t, 'camera');
    c.onReturn(c.H - 1, t, 'camera');
  }
  assert.equal(c.stop, 'rule');
});

test('направление «приближение»: труднее значит ближе, ступень вверх уменьшает дистанцию', () => {
  const c = mk(-1, 30, 36);
  assert.equal(c.H0, 31.5);
  let t = until(c, 0, () => 31.5, () => c.phase === 'hold', 3);
  t = until(c, t, () => 31.5, () => c.ups === 1, 30);
  assert.equal(c.ups, 1);
  assert.ok(c.H < 31.5, `H ${c.H}`);
  assert.deepEqual(mk(-1, 30, 36).command(true, 31.5), { key: 'enter', style: 'go' });
});

test('потолок: выше 115 % срыва не поднимаемся, продолжаем держать', () => {
  const c = new HoldController({ dir: 1, breakCm: 40, returnCm: 39, totalSec: 600, successSec: 1 });
  let t = 0;
  for (let k = 0; k < 20; k++) {
    t = run(c, t, 1.2, c.H);
    t = run(c, t, 1.3, c.H);
    t = run(c, t, 3.2, c.H);
  }
  assert.ok(c.H <= 46 + 1e-9, `H ${c.H}`);
  assert.ok(c.atLimit);
});

test('шкала: цель в центре, ближе слева, дальше справа', () => {
  const c = mk(1, 40, 34);
  assert.equal(c.gaugePos(c.H), 0.5);
  assert.ok(c.gaugePos(c.H - 5) < 0.5 && c.gaugePos(c.H + 5) > 0.5);
  assert.equal(c.gaugePos(NaN), 0.5);
});
