import test from 'node:test';
import assert from 'node:assert/strict';
import { CardPose, P2, cardPose, cardWarning, homography, irisMmFromCard } from '../src/core/card';
import { CARD_HEIGHT_MM, CARD_WIDTH_MM } from '../src/core/scale';
import { V3, add, eulerToR, mv } from '../src/core/linalg';
import { CAM, IRIS_MM, fixate, render, rng } from './synth';
import { irisDiamPx } from '../src/core/gaze';

const K = { f: CAM.f, cx: CAM.w / 2, cy: CAM.h / 2 };

/** Углы карты TL, TR, BR, BL в пикселях для заданного положения. */
function corners(tilt: { yaw: number; pitch: number; roll: number }, t: V3, noise = 0, rnd: () => number = Math.random, cam = K): P2[] {
  const R = eulerToR(tilt.yaw, tilt.pitch, tilt.roll);
  const m: V3[] = [[-CARD_WIDTH_MM / 2, -CARD_HEIGHT_MM / 2, 0], [CARD_WIDTH_MM / 2, -CARD_HEIGHT_MM / 2, 0], [CARD_WIDTH_MM / 2, CARD_HEIGHT_MM / 2, 0], [-CARD_WIDTH_MM / 2, CARD_HEIGHT_MM / 2, 0]];
  const g = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  return m.map((p) => {
    const c = add(mv(R, p), t);
    return { x: cam.cx + (cam.f * c[0]) / c[2] + noise * g(), y: cam.cy + (cam.f * c[1]) / c[2] + noise * g() };
  });
}
const truth = (z: number) => z / K.f;
const err = (p: CardPose, z: number) => p.mmPerPx / truth(z) - 1;

test('гомография воспроизводит четыре заданные точки', () => {
  const src: P2[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const dst: P2[] = [{ x: 10, y: 20 }, { x: 110, y: 30 }, { x: 120, y: 140 }, { x: 5, y: 120 }];
  const H = homography(src, dst);
  src.forEach((s, i) => {
    const w = H[6] * s.x + H[7] * s.y + H[8];
    assert.ok(Math.abs((H[0] * s.x + H[1] * s.y + H[2]) / w - dst[i].x) < 1e-6);
    assert.ok(Math.abs((H[3] * s.x + H[4] * s.y + H[5]) / w - dst[i].y) < 1e-6);
  });
});

test('масштаб по карте без шума: ошибка < 0,5 % при наклоне до 30°, повороте и смещении', () => {
  let worst = 0;
  for (const z of [300, 400, 500])
    for (const tilt of [{ yaw: 0, pitch: 0, roll: 0 }, { yaw: 20, pitch: 0, roll: 0 }, { yaw: 0, pitch: 25, roll: 10 }, { yaw: 15, pitch: 15, roll: 30 }, { yaw: -30, pitch: 10, roll: -20 }])
      for (const off of [[0, 0], [90, 10], [-80, 30]]) {
        const p = cardPose(corners(tilt, [off[0], off[1], z]), K);
        worst = Math.max(worst, Math.abs(err(p, z)));
      }
  assert.ok(worst < 0.005, `худшая ошибка ${(worst * 100).toFixed(2)} %`);
});

test('угол наклона и поворот карты определяются', () => {
  const p = cardPose(corners({ yaw: 20, pitch: 0, roll: 0 }, [60, 0, 400]), K);
  assert.ok(Math.abs(p.tiltDeg - 20) < 1.5, `наклон ${p.tiltDeg}`);
  const q = cardPose(corners({ yaw: 0, pitch: 0, roll: 25 }, [0, 0, 400]), K);
  assert.ok(Math.abs(q.rollDeg - 25) < 0.5, `поворот ${q.rollDeg}`);
});

test('порядок углов не важен: с любого угла, по часовой или против; книжная ориентация', () => {
  const rnd = rng(5);
  const base = corners({ yaw: 10, pitch: 5, roll: 15 }, [70, 0, 400], 0, rnd);
  const variants: P2[][] = [base, [base[2], base[3], base[0], base[1]], [...base].reverse(), [base[1], base[2], base[3], base[0]]];
  for (const v of variants) assert.ok(Math.abs(err(cardPose(v, K), 400)) < 0.005);
  const portrait = corners({ yaw: 0, pitch: 0, roll: 90 }, [0, 0, 400], 0, rnd);
  const p = cardPose(portrait, K);
  assert.ok(Math.abs(err(p, 400)) < 0.005);
});

test('шум отметки углов 1 px: СКО ошибки масштаба < 1 %, смещение < 0,5 % (карта ~ 300 px)', () => {
  const rnd = rng(6);
  const errs: number[] = [];
  for (let i = 0; i < 200; i++) errs.push(err(cardPose(corners({ yaw: 15, pitch: 8, roll: 10 }, [80, 0, 400], 1, rnd), K), 400));
  const m = errs.reduce((a, b) => a + b, 0) / errs.length;
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - m) ** 2, 0) / (errs.length - 1));
  assert.ok(sd < 0.01, `СКО ${(sd * 100).toFixed(2)} %`);
  assert.ok(Math.abs(m) < 0.005, `смещение ${(m * 100).toFixed(2)} %`);
});

test('мм/пиксель по карте почти не зависит от ошибки f на 15 %', () => {
  const p = cardPose(corners({ yaw: 15, pitch: 10, roll: 10 }, [70, 0, 400]), { ...K, f: K.f * 1.15 });
  assert.ok(Math.abs(err(p, 400)) < 0.02, `ошибка ${(err(p, 400) * 100).toFixed(2)} %`);
});

test('неточно отмеченные углы дают предупреждение, нормальные нет', () => {
  const ok = cardPose(corners({ yaw: 10, pitch: 5, roll: 5 }, [70, 0, 400]), K);
  assert.equal(cardWarning(ok), null);
  const c = corners({ yaw: 10, pitch: 5, roll: 5 }, [70, 0, 400]);
  c[2] = { x: c[2].x + 25, y: c[2].y - 20 };
  assert.equal(cardWarning(cardPose(c, K)), 'corners');
  assert.equal(cardWarning(cardPose(corners({ yaw: 45, pitch: 0, roll: 0 }, [0, 0, 400]), K)), 'tilt');
});

test('от кадра до диаметра радужки: карта у щеки, радужка из ландмарок, ошибка < 2 %', () => {
  const rnd = rng(7);
  const errs: number[] = [];
  for (let i = 0; i < 30; i++) {
    const fr = render(fixate(400), { yaw: 3, pitch: 2, roll: 1, zMm: 400 }, 0.3, rnd);
    const irisPx = (irisDiamPx(fr.lm, CAM.w, CAM.h, 'right') + irisDiamPx(fr.lm, CAM.w, CAM.h, 'left')) / 2;
    const c = corners({ yaw: 12, pitch: 6, roll: 20 }, [-95, 15, 400], 1, rnd); // карта рядом с лицом на той же глубине
    errs.push(irisMmFromCard(irisPx, cardPose(c, K)) / IRIS_MM - 1);
  }
  const m = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(Math.abs(m) < 0.02, `смещение ${(m * 100).toFixed(2)} %`);
});
