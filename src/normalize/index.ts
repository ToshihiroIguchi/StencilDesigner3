import type { Point, Ring, Polygon } from '../types';

/** Remove consecutive duplicate points from a ring. */
function removeDuplicates(ring: Ring): Ring {
  const result: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const prev = result[result.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) {
      result.push({ x: p.x, y: p.y });
    }
  }
  // Remove last point if it equals the first (explicit closure not allowed)
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (first.x === last.x && first.y === last.y) {
      result.pop();
    }
  }
  return result;
}

/** Remove collinear points (points on a straight line between neighbors). */
function removeCollinear(ring: Ring): Ring {
  if (ring.length < 3) return ring;
  const result: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    const cross = (curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x);
    if (cross !== 0) {
      result.push(curr);
    }
  }
  return result.length >= 3 ? result : ring;
}

/** Signed area × 2 (integer, no division). Positive = CCW, Negative = CW. */
export function signedArea2(ring: Ring): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i].x * ring[j].y;
    area -= ring[j].x * ring[i].y;
  }
  return area;
}

/** Ensure ring is counter-clockwise (CCW). Used for outer rings. */
function ensureCCW(ring: Ring): Ring {
  return signedArea2(ring) >= 0 ? ring : [...ring].reverse();
}

/** Ensure ring is clockwise (CW). Used for holes. */
function ensureCW(ring: Ring): Ring {
  return signedArea2(ring) <= 0 ? ring : [...ring].reverse();
}

/** Check for self-intersections using O(n²) sweep. Returns true if self-intersecting. */
export function hasSelfIntersection(ring: Ring): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent edges
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function cross2d(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = cross2d(b1, b2, a1);
  const d2 = cross2d(b1, b2, a2);
  const d3 = cross2d(a1, a2, b1);
  const d4 = cross2d(a1, a2, b2);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(a1, b1, b2)) return true;
  if (d2 === 0 && onSegment(a2, b1, b2)) return true;
  if (d3 === 0 && onSegment(b1, a1, a2)) return true;
  if (d4 === 0 && onSegment(b2, a1, a2)) return true;
  return false;
}

/** Normalize a single ring: remove duplicates, collinear points, enforce orientation. */
function normalizeRing(ring: Ring, isHole: boolean): Ring {
  let r = removeDuplicates(ring);
  r = removeCollinear(r);
  if (r.length < 3) return r;
  return isHole ? ensureCW(r) : ensureCCW(r);
}

/** Validate and normalize a polygon. Throws if geometry is irreparably invalid. */
export function normalize(polygon: Polygon): Polygon {
  const outer = normalizeRing(polygon.outer, false);
  if (outer.length < 3) {
    throw new Error(`Polygon ${polygon.id}: outer ring has fewer than 3 points after normalization`);
  }
  if (hasSelfIntersection(outer)) {
    // Flag as DRC error but keep the polygon for display
    console.warn(`Polygon ${polygon.id}: outer ring has self-intersections`);
  }

  const holes = polygon.holes
    .map((h) => normalizeRing(h, true))
    .filter((h) => h.length >= 3);

  return { ...polygon, outer, holes };
}

/** Normalize all polygons in a list. Filters out degenerate ones. */
export function normalizeAll(polygons: Polygon[]): Polygon[] {
  const result: Polygon[] = [];
  for (const poly of polygons) {
    try {
      result.push(normalize(poly));
    } catch {
      // Degenerate polygon - skip
    }
  }
  return result;
}

/** Compute signed area in µm² (may be large, use BigInt if needed for very large shapes). */
export function area(ring: Ring): number {
  return Math.abs(signedArea2(ring)) / 2;
}

/** Bounding box of a ring. */
export function bbox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Point-in-polygon test (ray casting). */
export function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
