import test from 'node:test';
import assert from 'node:assert/strict';
import { C, eulerToR, mm, mpMatrixToR, rToEuler, tr } from '../src/core/linalg';

test('euler → R → euler возвращает те же углы', () => {
  for (const [y, p, r] of [[10, -5, 3], [-20, 15, -8], [0, 0, 0], [35, 25, 12]]) {
    const e = rToEuler(eulerToR(y, p, r));
    assert.ok(Math.abs(e.yaw - y) < 1e-9 && Math.abs(e.pitch - p) < 1e-9 && Math.abs(e.roll - r) < 1e-9);
  }
});

test('R·Rᵀ = I и C·C = I', () => {
  const R = eulerToR(12, -7, 4);
  const I = mm(R, tr(R));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => assert.ok(Math.abs(I[i] - v) < 1e-12));
  const CC = mm(C, C);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => assert.ok(Math.abs(CC[i] - v) < 1e-12));
});

test('матрица MediaPipe (по столбцам, с масштабом и сдвигом) → чистый поворот', () => {
  const R = eulerToR(8, 5, -3);
  const k = 1.7; // масштаб в матрице должен игнорироваться
  const m = [R[0] * k, R[3] * k, R[6] * k, 0, R[1] * k, R[4] * k, R[7] * k, 0, R[2] * k, R[5] * k, R[8] * k, 0, 5, -3, -30, 1];
  const Rr = mpMatrixToR(m);
  Rr.forEach((v, i) => assert.ok(Math.abs(v - R[i]) < 1e-12));
});
