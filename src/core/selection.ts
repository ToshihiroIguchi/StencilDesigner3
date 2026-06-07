import type { Annotation, Dimension, Point, Polygon, Selection, ViewTransform } from '../types';
import { canvasToWorld } from '../types';
import { pointInRing } from '../normalize';
import { distSqPointToSegment, dist } from './geometry';
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
    if (dim.kind === 'centerline' || dim.kind === 'arrow') {
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

// ─── Annotation hit test ──────────────────────────────────────────────────────

export interface AnnHit { id: string }

/**
 * Hit test for annotation bounding boxes.
 * Uses a character-count heuristic for width (no canvas context available here).
 */
export function hitTestAnnotation(
  px: number, py: number,
  annotations: Annotation[],
  vt: ViewTransform,
): AnnHit | null {
  const CHAR_ASPECT = 0.6; // approximate em width / height ratio
  const LINE_RATIO = 1.2;
  const wp = canvasToWorld(px, py, vt);
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (!ann.text.trim()) continue;
    const lines = ann.text.split('\n');
    const maxChars = Math.max(...lines.map((l) => l.length), 1);
    const widthUm = maxChars * ann.heightUm * CHAR_ASPECT;
    const heightUm = lines.length * ann.heightUm * LINE_RATIO;
    if (
      wp.x >= ann.origin.x && wp.x <= ann.origin.x + widthUm &&
      wp.y >= ann.origin.y && wp.y <= ann.origin.y + heightUm
    ) {
      return { id: ann.id };
    }
  }
  return null;
}

/** Get all shapes that are fully within the rubber-band selection box. */
export function rubberBandSelect(
  x1: number, y1: number, x2: number, y2: number,
  shapes: Polygon[],
  dimensions: Dimension[],
  vt: ViewTransform,
  annotations: Annotation[] = [],
  selectableShapes: Polygon[] = shapes,
): Selection[] {
  const wp1 = canvasToWorld(Math.min(x1, x2), Math.min(y1, y2), vt);
  const wp2 = canvasToWorld(Math.max(x1, x2), Math.max(y1, y2), vt);

  const shapeSels: Selection[] = selectableShapes
    .filter((shape) => {
      return shape.outer.every(
        (p) => p.x >= wp1.x && p.x <= wp2.x && p.y >= wp1.y && p.y <= wp2.y
      );
    })
    .map((shape) => ({ type: 'polygon' as const, shapeId: shape.id, index: -1, holeIndex: -1 }));

  const dimSels: Selection[] = dimensions
    .filter((dim) => {
      const { p1, p2 } = resolveDimension(dim, shapes);
      let ds: Point, de: Point;
      if (dim.kind === 'centerline' || dim.kind === 'arrow') {
        ds = p1; de = p2;
      } else if (dim.kind === 'linear-h') {
        ds = { x: p1.x, y: dim.offset }; de = { x: p2.x, y: dim.offset };
      } else {
        ds = { x: dim.offset, y: p1.y }; de = { x: dim.offset, y: p2.y };
      }
      return p1.x >= wp1.x && p1.x <= wp2.x && p1.y >= wp1.y && p1.y <= wp2.y &&
             p2.x >= wp1.x && p2.x <= wp2.x && p2.y >= wp1.y && p2.y <= wp2.y &&
             ds.x >= wp1.x && ds.x <= wp2.x && ds.y >= wp1.y && ds.y <= wp2.y &&
             de.x >= wp1.x && de.x <= wp2.x && de.y >= wp1.y && de.y <= wp2.y;
    })
    .map((dim) => ({ type: 'dimension' as const, shapeId: dim.id, index: -1, holeIndex: -1 }));

  const CHAR_ASPECT = 0.6;
  const LINE_RATIO = 1.2;
  const annSels: Selection[] = annotations
    .filter((ann) => {
      if (!ann.text.trim()) return false;
      const lines = ann.text.split('\n');
      const maxChars = Math.max(...lines.map((l) => l.length), 1);
      const ox2 = ann.origin.x + maxChars * ann.heightUm * CHAR_ASPECT;
      const oy2 = ann.origin.y + lines.length * ann.heightUm * LINE_RATIO;
      return ann.origin.x >= wp1.x && ox2 <= wp2.x && ann.origin.y >= wp1.y && oy2 <= wp2.y;
    })
    .map((ann) => ({ type: 'annotation' as const, shapeId: ann.id, index: -1, holeIndex: -1 }));

  return [...shapeSels, ...dimSels, ...annSels];
}
