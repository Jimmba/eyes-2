// Масштаб по банковской карте (план 4.1б): по четырём отмеченным углам и известным размерам карты
// решается её положение в пространстве (гомография и плоский PnP). Наклон и поворот карты учитываются.
import { CARD_HEIGHT_MM, CARD_WIDTH_MM } from './scale';
import { V3, cross, dot, mul, norm, sub, toDeg, unit } from './linalg';

export interface P2 {
  x: number;
  y: number;
}
export interface CamK {
  f: number; // фокусное расстояние, px
  cx: number; // центр кадра, px
  cy: number;
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Углы карты лежат на одной прямой');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/** Гомография 3×3 (построчно, h22 = 1): точки плоскости карты (мм) → точки изображения. */
export function homography(src: P2[], dst: P2[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

export interface CardPose {
  /** мм на пиксель в плоскости, параллельной кадру, на глубине центра карты */
  mmPerPx: number;
  distanceMm: number; // до центра карты (зависит от f; мм/px от f почти не зависит)
  tiltDeg: number; // наклон карты относительно плоскости кадра
  rollDeg: number; // поворот карты в плоскости кадра
  reprojPx: number; // невязка по углам, px
  relErr: number; // невязка / средняя длина стороны
  portrait: boolean; // карта стоит «на ребре» (короткая сторона первой)
}

/**
 * corners: четыре угла по кругу (в любом направлении, с любого угла), px. Ориентация (альбомная или книжная)
 * определяется сама по меньшей невязке.
 */
export function cardPose(corners: P2[], cam: CamK, wMm = CARD_WIDTH_MM, hMm = CARD_HEIGHT_MM): CardPose {
  if (corners.length !== 4) throw new Error('Нужны четыре угла');
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  const pts = area >= 0 ? corners : [...corners].reverse(); // по часовой стрелке на экране (y вниз)
  const model: P2[] = [
    { x: -wMm / 2, y: -hMm / 2 },
    { x: wMm / 2, y: -hMm / 2 },
    { x: wMm / 2, y: hMm / 2 },
    { x: -wMm / 2, y: hMm / 2 },
  ];
  const dst = pts.map((p) => ({ x: (p.x - cam.cx) / cam.f, y: (p.y - cam.cy) / cam.f }));
  const edge = pts.reduce((s, p, i) => s + Math.hypot(p.x - pts[(i + 1) % 4].x, p.y - pts[(i + 1) % 4].y), 0) / 4;

  let best: CardPose | null = null;
  for (const k of [0, 1]) {
    const src = pts.map((_, i) => model[(i + k) % 4]);
    const H = homography(src, dst);
    const h1: V3 = [H[0], H[3], H[6]];
    const h2: V3 = [H[1], H[4], H[7]];
    const h3: V3 = [H[2], H[5], H[8]];
    const lam = 2 / (norm(h1) + norm(h2));
    let r1 = mul(h1, lam);
    let r2 = mul(h2, lam);
    let t = mul(h3, lam);
    if (t[2] < 0) {
      r1 = mul(r1, -1);
      r2 = mul(r2, -1);
      t = mul(t, -1);
    }
    r1 = unit(r1);
    r2 = unit(sub(r2, mul(r1, dot(r1, r2))));
    const r3 = cross(r1, r2);
    let se = 0;
    for (let i = 0; i < 4; i++) {
      const m = src[i];
      const p: V3 = [r1[0] * m.x + r2[0] * m.y + t[0], r1[1] * m.x + r2[1] * m.y + t[1], r1[2] * m.x + r2[2] * m.y + t[2]];
      const u = (cam.f * p[0]) / p[2] + cam.cx;
      const v = (cam.f * p[1]) / p[2] + cam.cy;
      se += (u - pts[i].x) ** 2 + (v - pts[i].y) ** 2;
    }
    const reprojPx = Math.sqrt(se / 4);
    const cand: CardPose = {
      mmPerPx: t[2] / cam.f,
      distanceMm: t[2],
      tiltDeg: toDeg(Math.acos(Math.min(1, Math.abs(r3[2])))),
      rollDeg: toDeg(Math.atan2(r1[1], r1[0])),
      reprojPx,
      relErr: reprojPx / edge,
      portrait: k === 1,
    };
    if (!best || cand.reprojPx < best.reprojPx) best = cand;
  }
  return best!;
}

/**
 * Карта прижата к щеке и лежит глубже радужки: роговица выступает вперёд на 10-16 мм. Радужка ближе к камере,
 * поэтому в кадре выглядит крупнее, чем была бы в плоскости карты, и без поправки диаметр завышается
 * на depthOffsetMm / расстояние (на 20-25 см это 5-6 %). Поправка: D = px · мм/px · (Z − δ) / Z.
 */
export const CARD_DEPTH_OFFSET_MM = 12;
export const irisMmFromCard = (irisPx: number, pose: CardPose, depthOffsetMm = CARD_DEPTH_OFFSET_MM): number =>
  irisPx * pose.mmPerPx * (1 - depthOffsetMm / pose.distanceMm);

export type CardWarning = 'tilt' | 'corners' | null;
/** Предупреждения для пользователя: слишком большой наклон или неточно отмечены углы. */
export function cardWarning(p: CardPose): CardWarning {
  if (p.relErr > 0.02) return 'corners';
  if (p.tiltDeg > 35) return 'tilt';
  return null;
}
