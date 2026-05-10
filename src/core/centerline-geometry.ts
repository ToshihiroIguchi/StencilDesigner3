import type { Point } from '../types';

/**
 * Test if two edges are nearly parallel using integer arithmetic (BigInt for overflow safety).
 * Threshold: sin θ ≤ 0.001 (≈ 0.057°).
 */
export function areEdgesParallel(e1: [Point, Point], e2: [Point, Point]): boolean {
  const d1x = BigInt(e1[1].x - e1[0].x);
  const d1y = BigInt(e1[1].y - e1[0].y);
  const d2x = BigInt(e2[1].x - e2[0].x);
  const d2y = BigInt(e2[1].y - e2[0].y);
  const cross = d1x * d2y - d1y * d2x;
  const len1Sq = d1x * d1x + d1y * d1y;
  const len2Sq = d2x * d2x + d2y * d2y;
  // |cross|² / (|d1|²·|d2|²) ≤ 0.001² ⟺ cross² · 1_000_000 ≤ len1Sq · len2Sq
  return cross * cross * 1_000_000n <= len1Sq * len2Sq;
}

function sqDist(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function midpointInt(a: Point, b: Point): Point {
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}

function parallelCenterline(e1: [Point, Point], e2: [Point, Point]): { p1: Point; p2: Point } {
  const [a1, a2] = e1;
  // Match endpoints by proximity so the centerline runs a1↔b1 and a2↔b2
  const d00 = sqDist(a1, e2[0]);
  const d01 = sqDist(a1, e2[1]);
  const [b1, b2] = d00 <= d01 ? [e2[0], e2[1]] : [e2[1], e2[0]];
  return { p1: midpointInt(a1, b1), p2: midpointInt(a2, b2) };
}

function bisectorCenterline(e1: [Point, Point], e2: [Point, Point]): { p1: Point; p2: Point } | null {
  const [a1, a2] = e1;
  const [b1, b2] = e2;
  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;

  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 0.5) return null; // effectively parallel

  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
  const ix = a1.x + t * dax;
  const iy = a1.y + t * day;

  const lenA = Math.sqrt(dax * dax + day * day);
  const lenB = Math.sqrt(dbx * dbx + dby * dby);
  if (lenA < 0.5 || lenB < 0.5) return null;

  // Bisector direction = normalized sum of unit direction vectors
  let bx = dax / lenA + dbx / lenB;
  let by = day / lenA + dby / lenB;
  const blen = Math.sqrt(bx * bx + by * by);
  if (blen < 1e-9) {
    // Anti-parallel: use perpendicular to edge 1
    bx = -day / lenA; by = dax / lenA;
  } else {
    bx /= blen; by /= blen;
  }

  // Choose the bisector direction toward the "inside" (between the two edges)
  const midA = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
  const midB = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };
  const midDir = { x: (midA.x + midB.x) / 2 - ix, y: (midA.y + midB.y) / 2 - iy };
  if (bx * midDir.x + by * midDir.y < 0) { bx = -bx; by = -by; }

  // Length = mean edge length / 2 (bisector extends from intersection)
  const halfLen = Math.round((lenA + lenB) / 4);
  return {
    p1: { x: Math.round(ix - halfLen * bx), y: Math.round(iy - halfLen * by) },
    p2: { x: Math.round(ix + halfLen * bx), y: Math.round(iy + halfLen * by) },
  };
}

/**
 * Compute the centerline between two edges.
 * - Parallel edges: midpoint-to-midpoint (endpoint-matched by proximity).
 * - Non-parallel: angle bisector through the intersection point.
 * Returns null if the geometry is degenerate.
 */
export function centerlineEndpoints(
  e1: [Point, Point],
  e2: [Point, Point],
): { p1: Point; p2: Point } | null {
  if (areEdgesParallel(e1, e2)) {
    return parallelCenterline(e1, e2);
  }
  return bisectorCenterline(e1, e2);
}
