import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_WIDTH_MM, cardScale, defaultScale, distanceMm, focalFromKnownDistance, focalFromVerticalFov, isPlausibleIris, manualScale, mmPerPxFromIris } from '../src/core/scale';

test('метод по умолчанию 11,7 мм', () => {
  assert.deepEqual(defaultScale(), { method: 'default', irisMm: 11.7 });
});

test('ручной ввод проверяет диапазон', () => {
  assert.equal(manualScale(12).irisMm, 12);
  assert.throws(() => manualScale(14.5), RangeError); // это диаметр линзы, не радужки
  assert.throws(() => manualScale(NaN), RangeError);
});

test('карта: радужка 70 px при карте 512 px → 11,7 мм', () => {
  const cardPx = (CARD_WIDTH_MM * 70) / 11.7;
  const s = cardScale(70, cardPx);
  assert.equal(s.method, 'card');
  assert.ok(Math.abs(s.irisMm - 11.7) < 1e-9);
  assert.ok(isPlausibleIris(s.irisMm));
  assert.ok(!isPlausibleIris(cardScale(70, 400).irisMm)); // 15 мм: карта выставлена неверно
});

test('расстояние: f из известной дистанции и обратно', () => {
  const f = focalFromKnownDistance(60, 11.7, 400);
  const s = mmPerPxFromIris(11.7, 60);
  assert.ok(Math.abs(distanceMm(f, s) - 400) < 1e-9);
});

test('запасной f по вертикальному FOV 63°', () => {
  assert.ok(Math.abs(focalFromVerticalFov(1920) - 1566.6) < 1);
});

test('поле зрения по диагонали паспорта: кадр 16:9 из сенсора 4:3 и портретный 9:16', async () => {
  const { fovVerticalFromDiagonal } = await import('../src/core/scale');
  // диагональ 80°: вертикаль 16:9 заметно меньше, чем у портретного кадра (там вертикаль длинная сторона)
  const land = fovVerticalFromDiagonal(80, 1280, 720);
  const port = fovVerticalFromDiagonal(80, 720, 1280);
  assert.ok(land > 35 && land < 50, `landscape ${land}`);
  assert.ok(port > 55 && port < 75, `portrait ${port}`);
  assert.ok(Math.abs(fovVerticalFromDiagonal(80, 4, 3) - 2 * Math.atan(0.6 * Math.tan((80 * Math.PI) / 360)) * 180 / Math.PI) < 1e-6);
});

test('высота буквы по угловым минутам: 7,5′ на 40 см ≈ 0,87 мм; растёт линейно с расстоянием', async () => {
  const { letterHeightMm } = await import('../src/core/scale');
  assert.ok(Math.abs(letterHeightMm(7.5, 400) - 0.8727) < 0.005);
  assert.ok(Math.abs(letterHeightMm(15, 800) / letterHeightMm(15, 400) - 2) < 1e-6);
});
