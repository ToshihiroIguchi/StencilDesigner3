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



/**
 * Ratio by which the centerline extends beyond each endpoint.
 * 0.1 = 10% of the centerline length on each side, matching AutoCAD LT convention.
 * Being proportional (not absolute) means it scales naturally with any shape size.
 */
const CENTERLINE_EXTENSION_RATIO = 0.1;

function parallelCenterline(e1: [Point, Point], e2: [Point, Point]): { p1: Point; p2: Point } {
  const [a1, a2] = e1;
  const [b1, b2] = e2;
  
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const len1 = Math.sqrt(d1x * d1x + d1y * d1y);
  
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const len2 = Math.sqrt(d2x * d2x + d2y * d2y);

  if (len1 < 0.5 && len2 < 0.5) return { p1: a1, p2: b1 }; // degenerate

  // Reference direction (from longer edge)
  let ux = 0, uy = 0;
  if (len1 >= len2) {
    ux = d1x / len1; uy = d1y / len1;
  } else {
    ux = d2x / len2; uy = d2y / len2;
    if (ux * d1x + uy * d1y < 0) { ux = -ux; uy = -uy; } // Align directions
  }

  // Midpoint between the two parallel infinite lines
  let midX = 0, midY = 0;
  if (len2 >= 0.5) {
    // Project a1 onto line e2
    const v_x = a1.x - b1.x, v_y = a1.y - b1.y;
    const e2_ux = d2x / len2, e2_uy = d2y / len2;
    const dot = v_x * e2_ux + v_y * e2_uy;
    const projX = b1.x + dot * e2_ux;
    const projY = b1.y + dot * e2_uy;
    midX = (a1.x + projX) / 2;
    midY = (a1.y + projY) / 2;
  } else if (len1 >= 0.5) {
    // e2 is a point, project b1 onto line e1
    const v_x = b1.x - a1.x, v_y = b1.y - a1.y;
    const e1_ux = d1x / len1, e1_uy = d1y / len1;
    const dot = v_x * e1_ux + v_y * e1_uy;
    const projX = a1.x + dot * e1_ux;
    const projY = a1.y + dot * e1_uy;
    midX = (b1.x + projX) / 2;
    midY = (b1.y + projY) / 2;
  }

  // Project all 4 endpoints onto the reference direction vector
  const proj = (p: Point) => (p.x - midX) * ux + (p.y - midY) * uy;
  const pA1 = proj(a1), pA2 = proj(a2);
  const pB1 = proj(b1), pB2 = proj(b2);

  const minP = Math.min(pA1, pA2, pB1, pB2);
  const maxP = Math.max(pA1, pA2, pB1, pB2);
  const baseLen = maxP - minP;
  const ext = baseLen * CENTERLINE_EXTENSION_RATIO;

  return {
    p1: { x: Math.round(midX + (minP - ext) * ux), y: Math.round(midY + (minP - ext) * uy) },
    p2: { x: Math.round(midX + (maxP + ext) * ux), y: Math.round(midY + (maxP + ext) * uy) },
  };
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

  // Half-length = mean edge length / 2, extended by CENTERLINE_EXTENSION_RATIO on each end
  const baseHalf = Math.round((lenA + lenB) / 4);
  const ext = Math.round(baseHalf * 2 * CENTERLINE_EXTENSION_RATIO);
  const halfLen = baseHalf + ext;
  return {
    p1: { x: Math.round(ix - halfLen * bx), y: Math.round(iy - halfLen * by) },
    p2: { x: Math.round(ix + halfLen * bx), y: Math.round(iy + halfLen * by) },
  };
}

/**
 * Compute the centerline between two edges.
 * - Parallel edges: midpoint-to-midpoint, extended by 10% on each end.
 * - Non-parallel: angle bisector through the intersection point, same extension ratio.
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
