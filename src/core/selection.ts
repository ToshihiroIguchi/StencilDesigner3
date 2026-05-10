import type { Dimension, Point, Polygon, Selection, ViewTransform } from '../types';
import { canvasToWorld } from '../types';
import { pointInRing } from '../normalize';
import { distSqPointToSegment, midpoint, dist, isRingCircleLike, ringCentroid } from './geometry';
import { resolveDimension } from './dimension-resolve';

/**
 * Hit test at canvas coordinates (px, py).
 * Priority: vertex > edge > polygon interior.
 */
export function hitTest(
  px: number,
  py: number,
  shapes: Polygon[],
  vt: ViewTransform,
  snapRadius: number
): Selection | null {
  const wp = canvasToWorld(px, py, vt);
  const snapRadiusWorld = snapRadius / vt.zoom;

  // 1. Vertex check
  for (const shape of shapes) {
    const rings = [{ ring: shape.outer, holeIndex: -1 }, ...shape.holes.map((h, i) => ({ ring: h, holeIndex: i }))];
    for (const { ring, holeIndex } of rings) {
      for (let i = 0; i < ring.length; i++) {
        if (dist(wp, ring[i]) <= snapRadiusWorld) {
          return { type: 'vertex', shapeId: shape.id, index: i, holeIndex };
        }
      }
    }
  }

  // 2. Edge check
  for (const shape of shapes) {
    const rings = [{ ring: shape.outer, holeIndex: -1 }, ...shape.holes.map((h, i) => ({ ring: h, holeIndex: i }))];
    for (const { ring, holeIndex } of rings) {
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const dSq = distSqPointToSegment(wp, ring[i], ring[j]);
        if (Math.sqrt(dSq) <= snapRadiusWorld) {
          return { type: 'edge', shapeId: shape.id, index: i, holeIndex };
        }
      }
    }
  }

  // 3. Polygon interior check (test in reverse order = topmost first)
  for (let s = shapes.length - 1; s >= 0; s--) {
    const shape = shapes[s];
    if (pointInRing(wp, shape.outer)) {
      let inHole = false;
      for (const hole of shape.holes) {
        if (pointInRing(wp, hole)) { inHole = true; break; }
      }
      if (!inHole) {
        return { type: 'polygon', shapeId: shape.id, index: -1, holeIndex: -1 };
      }
    }
  }

  return null;
}

/** Find the nearest snap point in world coordinates. Priority: endpoint > midpoint > grid. */
export function findSnapPoint(
  worldPt: Point,
  shapes: Polygon[],
  gridSize: number,
  snapRadius: number, // world units
  excludeShapeId?: string
): Point {
  let best: Point = { x: worldPt.x, y: worldPt.y };
  let bestDist = snapRadius;

  for (const shape of shapes) {
    if (shape.id === excludeShapeId) continue;
    const rings = [shape.outer, ...shape.holes];
    for (const ring of rings) {
      // Center snap for circular rings (circleToPolygon-style n-gons with n >= 12)
      if (isRingCircleLike(ring)) {
        const c = ringCentroid(ring);
        const d = dist(worldPt, c);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      // Endpoints
      for (const p of ring) {
        const d = dist(worldPt, p);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      // Midpoints
      for (let i = 0; i < ring.length; i++) {
        const mp = midpoint(ring[i], ring[(i + 1) % ring.length]);
        const d = dist(worldPt, mp);
        if (d < bestDist) { bestDist = d; best = mp; }
      }
    }
  }

  // Grid snap: always round to nearest grid when no vertex/midpoint is closer
  if (bestDist === snapRadius) {
    best = {
      x: Math.round(worldPt.x / gridSize) * gridSize,
      y: Math.round(worldPt.y / gridSize) * gridSize,
    };
  }

  return best;
}

// ─── Annotation hit test ──────────────────────────────────────────────────────

// ─── Dimension hit test ───────────────────────────────────────────────────────

export interface DimHit {
  id: string;
  part: 'p1' | 'p2' | 'dimLine';
}

export function hitTestDimension(
  px: number, py: number,
  dimensions: Dimension[],
  shapes: Polygon[],
  vt: ViewTransform,
  snapRadius: number,
): DimHit | null {
  const wp = canvasToWorld(px, py, vt);
  const r = snapRadius / vt.zoom;
  for (let i = dimensions.length - 1; i >= 0; i--) {
    const dim = dimensions[i];
    const { p1, p2 } = resolveDimension(dim, shapes);
    if (dist(wp, p1) <= r) return { id: dim.id, part: 'p1' };
    if (dist(wp, p2) <= r) return { id: dim.id, part: 'p2' };
    let ds: Point, de: Point;
    if (dim.kind === 'centerline') {
      ds = p1; de = p2;
    } else if (dim.kind === 'linear-h') {
      ds = { x: p1.x, y: dim.offset }; de = { x: p2.x, y: dim.offset };
    } else {
      ds = { x: dim.offset, y: p1.y }; de = { x: dim.offset, y: p2.y };
    }
    if (Math.sqrt(distSqPointToSegment(wp, ds, de)) <= r)
      return { id: dim.id, part: 'dimLine' };
  }
  return null;
}

/** Get all shapes that are fully within the rubber-band selection box. */
export function rubberBandSelect(
  x1: number, y1: number, x2: number, y2: number,
  shapes: Polygon[],
  vt: ViewTransform
): Selection[] {
  const wp1 = canvasToWorld(Math.min(x1, x2), Math.min(y1, y2), vt);
  const wp2 = canvasToWorld(Math.max(x1, x2), Math.max(y1, y2), vt);

  return shapes
    .filter((shape) => {
      return shape.outer.every(
        (p) => p.x >= wp1.x && p.x <= wp2.x && p.y >= wp1.y && p.y <= wp2.y
      );
    })
    .map((shape) => ({ type: 'polygon' as const, shapeId: shape.id, index: -1, holeIndex: -1 }));
}
