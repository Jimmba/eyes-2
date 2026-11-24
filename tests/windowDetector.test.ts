import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DetEvent } from '../src/core/breakDetector';
import { WIN_DEFAULTS, WindowDetector, windowNoise } from '../src/core/windowDetector';

interface Scene {
  cols: string[];
  rows: (number | null)[][];
}
const fx: Record<string, Scene> = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/measure-2026-11-24.json'), 'utf8'));

/** Прогон сцены из журнала (замеры 24 ноября): валидный кадр = глаза открыты (> 0,25) и есть сигнал. */
function replay(name: string): { ev: (DetEvent & { sec: number })[]; press: number[]; release: number[]; t0: number } {
  const sc = fx[name];
  const ix = (c: string) => sc.cols.indexOf(c);
  const det = new WindowDetector();
  const t0 = sc.rows[0][0] as number;
  const ev: (DetEvent & { sec: number })[] = [];
  const press: number[] = [];
  const release: number[] = [];
  let prev = 0;
  for (const r of sc.rows) {
    const open = Math.min((r[ix('R_open')] as number) ?? 0, (r[ix('L_open')] as number) ?? 0);
    const v = r[ix('dev_inst')];
    const e = det.push({ t: r[0] as number, value: v ?? NaN, valid: v !== null && open > 0.25, z: r[ix('z_mm')] as number });
    if (e) ev.push({ ...e, sec: ((e.onsetT as number) - t0) / 1000 });
    const u = r[ix('user_hold')] as number;
    if (u === 1 && prev === 0) press.push(((r[0] as number) - t0) / 1000);
    if (u === 0 && prev === 1) release.push(((r[0] as number) - t0) / 1000);
    prev = u;
  }
  return { ev, press, release, t0 };
}

test('журнал 24.11, замер 3: срыв найден раньше нажатия пользователя (реакция 1-2 с), возврат около отпускания', () => {
  const { ev, press, release } = replay('measure_3');
  const b = ev.find((e) => e.type === 'break');
  const r = ev.find((e) => e.type === 'return');
  assert.ok(b && r, 'нужны срыв и возврат');
  const lag = press[0] - b.sec;
  assert.ok(lag > 0.3 && lag < 3, `пользователь позже камеры на ${lag.toFixed(1)} с`);
  assert.ok(Math.abs(r.sec - release[0]) < 2, `возврат ${r.sec.toFixed(1)} с, отпускание ${release[0].toFixed(1)} с`);
  assert.ok(b.z / 10 > 24 && b.z / 10 < 31, `дистанция срыва ${b.z / 10} см`);
  assert.equal(ev.filter((e) => e.type === 'break').length, 1, 'после возврата ложного срыва нет');
});

test('журнал 24.11, замер 1: срыв (около 6° над базой) найден до нажатия, возврат раньше отпускания', () => {
  const { ev, press, release } = replay('measure_1');
  const b = ev.find((e) => e.type === 'break');
  const r = ev.find((e) => e.type === 'return');
  assert.ok(b && r);
  assert.ok(b.sec < press[0] && press[0] - b.sec < 3, `срыв ${b.sec.toFixed(1)} с, нажатие ${press[0].toFixed(1)} с`);
  assert.ok(r.sec > b.sec && r.sec < release[0] + 1, `возврат ${r.sec.toFixed(1)} с`);
});

test('журнал 24.11, замер 2 (пограничное состояние на одном расстоянии): ложных срывов вне нажатия нет', () => {
  const { ev, press, release } = replay('measure_2');
  for (const e of ev) {
    assert.ok(e.sec > press[0] - 3 && e.sec < release[0] + 3, `событие ${e.type} вне нажатия: ${e.sec.toFixed(1)} с`);
  }
});

test('в первые секунды (оседание базы) срывов не ищем', () => {
  for (const k of ['measure_1', 'measure_2', 'measure_3']) {
    const { ev } = replay(k);
    assert.ok(ev.every((e) => e.sec >= 2.0), `${k}: ранний срыв ${ev[0]?.sec}`);
  }
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

test('синтетика: шум кадра ±4° в покое 30 с даёт ложный срыв редко (< 5 % прогонов)', () => {
  let bad = 0;
  for (let k = 0; k < 200; k++) {
    const r = rng(k + 1);
    const det = new WindowDetector();
    let hit = false;
    for (let i = 0; i < 270; i++) if (det.push({ t: i * 111, value: gauss(r) * 4, valid: true, z: 250 })?.type === 'break') hit = true;
    if (hit) bad++;
  }
  assert.ok(bad / 200 < 0.05, `ложных срывов в ${bad} из 200 прогонов`);
});

test('синтетика: сдвиг +8° на 4 с находится за ~1,5 с, возврат за ~2 с, чувствительность ≥ 95 %', () => {
  let found = 0;
  const delays: number[] = [];
  for (let k = 0; k < 100; k++) {
    const r = rng(1000 + k);
    const det = new WindowDetector();
    let tb = NaN;
    let tr = NaN;
    for (let i = 0; i < 270; i++) {
      const t = i * 111;
      const shift = t >= 8000 && t < 12000 ? 8 : 0;
      const e = det.push({ t, value: shift + gauss(r) * 4, valid: true, z: 250 });
      if (e?.type === 'break' && Number.isNaN(tb)) tb = e.t;
      if (e?.type === 'return' && Number.isNaN(tr)) tr = e.t;
    }
    if (Number.isFinite(tb) && Number.isFinite(tr)) {
      found++;
      delays.push((tb - 8000) / 1000);
    }
  }
  assert.ok(found >= 95, `найдено ${found} из 100`);
  delays.sort((a, b) => a - b);
  assert.ok(delays[Math.floor(delays.length / 2)] < 2.2, `медианная задержка ${delays[Math.floor(delays.length / 2)]} с`);
});

test('касание: forceBroken и forceFused синхронизируют детектор', () => {
  const det = new WindowDetector();
  const r = rng(5);
  for (let i = 0; i < 60; i++) det.push({ t: i * 111, value: gauss(r) * 3, valid: true, z: 250 });
  det.forceBroken();
  assert.equal(det.state, 'broken');
  let ret: DetEvent | null = null;
  for (let i = 60; i < 120 && !ret; i++) {
    const e = det.push({ t: i * 111, value: gauss(r) * 3, valid: true, z: 250 });
    if (e?.type === 'return') ret = e;
  }
  assert.ok(ret, 'возврат к базе после касания находится');
  det.forceBroken();
  det.forceFused(20000);
  assert.equal(det.state, 'fused');
});

test('шум окна: медианы за 1 с тише отдельных кадров', () => {
  const r = rng(11);
  const ts: number[] = [];
  const xs: number[] = [];
  for (let i = 0; i < 90; i++) {
    ts.push(i * 111);
    xs.push(gauss(r) * 4.5);
  }
  const w = windowNoise(ts, xs);
  assert.ok(w > 0.5 && w < 3, `шум окна ${w}`);
  assert.equal(WIN_DEFAULTS.thresholdDeg, 5);
});
