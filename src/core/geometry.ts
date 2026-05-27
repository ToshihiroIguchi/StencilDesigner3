import type { Point, Ring, Polygon, Vertex } from '../types';
import { newId } from '../types';
import { normalize, bbox, area } from '../normalize';
import { vertex } from './vertex';

/** 
 * Calculate number of sides for a circle approximation to keep chord error small.
 * Max chord error of 0.5 µm ensures the polygon stays visually and physically smooth.
 */
export function getCircleSegments(r: number): number {
  if (r <= 0) return 4;
  const maxChordError = 0.5; // µm
  if (r <= maxChordError) return 8;
  const theta = 2 * Math.acos(1 - maxChordError / r);
  const calculated = Math.ceil((2 * Math.PI) / theta);
  return Math.min(2048, Math.max(32, calculated));
}

/** Approximate a circle as a polygon with dynamic or explicit sides. */
export function circleToPolygon(cx: number, cy: number, r: number, sides?: number, layer = '0'): Polygon {
  const nSides = sides ?? getCircleSegments(r);
  const outer: Ring = [];
  for (let i = 0; i < nSides; i++) {
    const angle = (2 * Math.PI * i) / nSides;
    outer.push(vertex(cx + r * Math.cos(angle), cy + r * Math.sin(angle)));
  }
  return normalize({ id: newId(), outer, holes: [], layer });
}

/** Create a rectangle polygon from two corner points. */
export function rectToPolygon(x1: number, y1: number, x2: number, y2: number, layer = '0'): Polygon {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const maxX = Math.max(x1, x2);
  const maxY = Math.max(y1, y2);
  const outer: Ring = [
    vertex(minX, minY),
    vertex(maxX, minY),
    vertex(maxX, maxY),
    vertex(minX, maxY),
  ];
  return normalize({ id: newId(), outer, holes: [], layer });
}

/** Get polygon bounding box. */
export function polygonBbox(poly: Polygon): { minX: number; minY: number; maxX: number; maxY: number } {
  return bbox(poly.outer);
}

/** Get polygon area in µm². */
export function polygonArea(poly: Polygon): number {
  let a = area(poly.outer);
  for (const hole of poly.holes) {
    a -= area(hole);
  }
  return a;
}

/** Translate a ring by (dx, dy), preserving vertex IDs. */
export function translateRing(ring: Ring, dx: number, dy: number): Ring {
  return ring.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
}

/** Translate a polygon by (dx, dy). All values must be integers. */
export function translatePolygon(poly: Polygon, dx: number, dy: number): Polygon {
  return {
    ...poly,
    id: newId(),
    outer: translateRing(poly.outer, dx, dy),
    holes: poly.holes.map((h) => translateRing(h, dx, dy)),
  };
}

/** Deep clone a polygon with a new ID, preserving vertex IDs. */
export function clonePolygon(poly: Polygon): Polygon {
  return {
    id: newId(),
    layer: poly.layer,
    outer: poly.outer.map((p) => ({ ...p })),
    holes: poly.holes.map((h) => h.map((p) => ({ ...p }))),
  };
}

/** Distance squared from point to segment (for hit testing). */
export function distSqPointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x, ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const fx = p.x - cx, fy = p.y - cy;
  return fx * fx + fy * fy;
}

/** Midpoint of a segment (integer). */
export function midpoint(a: Point, b: Point): Point {
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}

/** Snap a world point to the nearest grid point. */
export function snapToGrid(p: Point, gridSize: number): Point {
  return {
    x: Math.round(p.x / gridSize) * gridSize,
    y: Math.round(p.y / gridSize) * gridSize,
  };
}

/** Distance between two points. */
export function dist(a: Point, b: Point): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Minimum distance squared between two line segments. */
export function segmentMinDistanceSq(a1: Point, a2: Point, b1: Point, b2: Point): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    distSqPointToSegment(a1, b1, b2),
    distSqPointToSegment(a2, b1, b2),
    distSqPointToSegment(b1, a1, a2),
    distSqPointToSegment(b2, a1, a2),
  );
}

/**
 * Compute the intersection point of segment a1→a2 with segment b1→b2.
 * Returns null if segments don't intersect or are collinear/parallel.
 * Returns the parameter t along a1→a2 and the integer-rounded intersection point.
 */
export function segmentIntersectionPoint(
  a1: Point, a2: Point, b1: Point, b2: Point,
): { t: number; u: number; pt: Point } | null {
  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (denom === 0) return null; // parallel or collinear
  const cx = b1.x - a1.x, cy = b1.y - a1.y;
  const t = (cx * dby - cy * dbx) / denom;
  const u = (cx * day - cy * dax) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {
    t,
    u,
    pt: { x: Math.round(a1.x + t * dax), y: Math.round(a1.y + t * day) },
  };
}

/** Returns true if segment a1→a2 and b1→b2 properly intersect (strict sign change). */
export function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(b1, b2, a1), d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1), d4 = cross(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Point-in-ring test (ray casting, even-odd rule). */
export function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    if (((yi > p.y) !== (yj > p.y)) &&
        p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Returns true if any edge of ring a intersects any edge of ring b. */
export function ringsEdgesIntersect(a: Ring, b: Ring): boolean {
  const na = a.length, nb = b.length;
  for (let i = 0; i < na; i++) {
    const a1 = a[i], a2 = a[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % nb])) return true;
    }
  }
  return false;
}

/** Returns true if polygon a and b overlap (edge intersection or containment). */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  if (ringsEdgesIntersect(a.outer, b.outer)) return true;
  if (pointInRing(a.outer[0], b.outer)) return true;
  if (pointInRing(b.outer[0], a.outer)) return true;
  return false;
}

export function ringCentroid(ring: Ring): Point {
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p.x; sy += p.y; }
  return { x: Math.round(sx / ring.length), y: Math.round(sy / ring.length) };
}

/**
 * True if the ring is an approximately regular n-gon with n >= 12 (≈ a circle).
 */
export function isRingCircleLike(ring: Ring): boolean {
  if (ring.length < 12) return false;
  const c = ringCentroid(ring);
  let sum = 0;
  for (const p of ring) sum += dist(p, c);
  const avg = sum / ring.length;
  if (avg < 1) return false;
  const tol = Math.max(2, avg * 0.02);
  for (const p of ring) {
    if (Math.abs(dist(p, c) - avg) > tol) return false;
  }
  return true;
}

/**
 * Minimum edge-to-edge distance between two polygons.
 * Returns dist=0 if they overlap, with loc at the approximate midpoint.
 */
export function polygonEdgeDistance(a: Polygon, b: Polygon): { dist: number; loc: Point } {
  if (polygonsOverlap(a, b)) {
    const ca = ringCentroid(a.outer), cb = ringCentroid(b.outer);
    return { dist: 0, loc: { x: Math.round((ca.x + cb.x) / 2), y: Math.round((ca.y + cb.y) / 2) } };
  }
  const na = a.outer.length, nb = b.outer.length;
  let minSq = Infinity;
  let midA: Point = a.outer[0], midB: Point = b.outer[0];
  for (let i = 0; i < na; i++) {
    const a1 = a.outer[i], a2 = a.outer[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      const b1 = b.outer[j], b2 = b.outer[(j + 1) % nb];
      const dsq = segmentMinDistanceSq(a1, a2, b1, b2);
      if (dsq < minSq) {
        minSq = dsq;
        midA = { x: Math.round((a1.x + a2.x) / 2), y: Math.round((a1.y + a2.y) / 2) };
        midB = { x: Math.round((b1.x + b2.x) / 2), y: Math.round((b1.y + b2.y) / 2) };
      }
    }
  }
  return {
    dist: Math.sqrt(minSq),
    loc: { x: Math.round((midA.x + midB.x) / 2), y: Math.round((midA.y + midB.y) / 2) },
  };
}

/** Nearest point on segment s1→s2 to point p (float arithmetic for internal use). */
function nearestOnSegmentF(
  px: number, py: number, s1x: number, s1y: number, s2x: number, s2y: number,
): [number, number] {
  const dx = s2x - s1x, dy = s2y - s1y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return [s1x, s1y];
  const t = Math.max(0, Math.min(1, ((px - s1x) * dx + (py - s1y) * dy) / lenSq));
  return [s1x + t * dx, s1y + t * dy];
}

function connectingDirNearlyParallel(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const candidates: Array<[number, number, number, number]> = [
    [a1.x, a1.y, ...nearestOnSegmentF(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y)],
    [a2.x, a2.y, ...nearestOnSegmentF(a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)],
    [...nearestOnSegmentF(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y), b1.x, b1.y],
    [...nearestOnSegmentF(b2.x, b2.y, a1.x, a1.y, a2.x, a2.y), b2.x, b2.y],
  ];
  let minDsq = Infinity, px = 0, py = 0, qx = 0, qy = 0;
  for (const [ax, ay, bx, by] of candidates) {
    const d = (ax - bx) ** 2 + (ay - by) ** 2;
    if (d < minDsq) { minDsq = d; px = ax; py = ay; qx = bx; qy = by; }
  }
  const dx = qx - px, dy = qy - py;
  const dLen = Math.sqrt(dx * dx + dy * dy);
  if (dLen < 0.5) return false;

  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;
  const daLen = Math.sqrt(dax * dax + day * day);
  const dbLen = Math.sqrt(dbx * dbx + dby * dby);
  if (daLen < 0.5 || dbLen < 0.5) return false;

  const cosA = Math.abs(dax * dx + day * dy) / (daLen * dLen);
  const cosB = Math.abs(dbx * dx + dby * dy) / (dbLen * dLen);
  return cosA > 0.7 || cosB > 0.7;
}

/**
 * Narrowest passage width of a polygon (min distance between non-adjacent edges).
 */
export function polygonNarrowestPassage(poly: Polygon): { width: number; loc: Point } {
  const ring = poly.outer;
  const n = ring.length;
  if (n < 4) return { width: Infinity, loc: ring[0] };
  let minSq = Infinity;
  let bestLoc: Point = ring[0];
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // wrapping adjacency
      const b1 = ring[j], b2 = ring[(j + 1) % n];
      const dsq = segmentMinDistanceSq(a1, a2, b1, b2);
      if (dsq < minSq) {
        if (connectingDirNearlyParallel(a1, a2, b1, b2)) continue;
        minSq = dsq;
        bestLoc = {
          x: Math.round((a1.x + a2.x + b1.x + b2.x) / 4),
          y: Math.round((a1.y + a2.y + b1.y + b2.y) / 4),
        };
      }
    }
  }
  return { width: Math.sqrt(minSq), loc: bestLoc };
}

/**
 * Constrain point `to` to multiples of `stepDeg` degrees from `from`.
 * The distance between the two points is preserved.
 * Result coordinates are rounded to the nearest integer µm.
 */
export function constrainAngle(from: Point, to: Point, stepDeg: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distVal = Math.sqrt(dx * dx + dy * dy);
  if (distVal === 0) return to;
  const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
  const snappedDeg = Math.round(angleDeg / stepDeg) * stepDeg;
  const rad = snappedDeg * (Math.PI / 180);
  return {
    x: Math.round(from.x + distVal * Math.cos(rad)),
    y: Math.round(from.y + distVal * Math.sin(rad)),
  };
}

// Re-export Vertex for convenience
export type { Vertex };
