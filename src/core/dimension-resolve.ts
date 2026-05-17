import type { Polygon, Point, Dimension, DimensionAnchor } from '../types';
import { centerlineEndpoints } from './centerline-geometry';

function getRing(shape: Polygon, ringIndex: number): import('../types').Ring | null {
  if (ringIndex === -1) return shape.outer;
  if (ringIndex >= 0 && ringIndex < shape.holes.length) return shape.holes[ringIndex];
  return null;
}

/** Returns the live Point for all anchor kinds. */
export function resolveAnchor(anchor: DimensionAnchor, shapes: Polygon[]): Point | null {
  if (anchor.kind === 'free') return anchor.point;
  if (anchor.kind === 'vertex') {
    const shape = shapes.find((s) => s.id === anchor.shapeId);
    if (!shape) return null;
    const ring = getRing(shape, anchor.ringIndex);
    if (!ring) return null;
    const v = ring.find((p) => p.id === anchor.vertexId);
    return v ?? null;
  }
  if (anchor.kind === 'edge') {
    const edge = resolveEdge(anchor, shapes);
    if (!edge) return null;
    const [a, b] = edge;
    return {
      x: Math.round(a.x + anchor.t * (b.x - a.x)),
      y: Math.round(a.y + anchor.t * (b.y - a.y)),
    };
  }
  return null;
}

/** Returns [edgeStart, edgeEnd] for 'edge' anchors. Returns null otherwise. */
export function resolveEdge(
  anchor: DimensionAnchor,
  shapes: Polygon[],
): [Point, Point] | null {
  if (anchor.kind !== 'edge') return null;
  const shape = shapes.find((s) => s.id === anchor.shapeId);
  if (!shape) return null;
  const ring = getRing(shape, anchor.ringIndex);
  if (!ring) return null;
  const start = ring.find((p) => p.id === anchor.edgeStartId);
  const end = ring.find((p) => p.id === anchor.edgeEndId);
  if (!start || !end) return null;
  return [start, end];
}

/** Fallback: cached point stored in anchor (last resolved value). */
function getAnchorCache(anchor: DimensionAnchor): Point {
  if (anchor.kind === 'free') return anchor.point;
  return anchor.cachedPoint;
}

/**
 * Resolve a dimension to its display endpoints and frozen state.
 * - linear-h / linear-v: resolve 'vertex' or 'free' anchors
 * - centerline: resolve two 'edge' anchors, compute centerline geometry
 *
 * Falls back to cachedPoint when the live shape is unavailable.
 */
export function resolveDimension(
  dim: Dimension,
  shapes: Polygon[],
): { p1: Point; p2: Point; frozen: boolean } {
  if (dim.frozen) {
    return {
      p1: getAnchorCache(dim.anchor1),
      p2: getAnchorCache(dim.anchor2),
      frozen: true,
    };
  }

  if (dim.kind === 'centerline') {
    const e1 = resolveEdge(dim.anchor1, shapes);
    const e2 = resolveEdge(dim.anchor2, shapes);
    if (e1 && e2) {
      const cl = centerlineEndpoints(e1, e2);
      if (cl) return { p1: cl.p1, p2: cl.p2, frozen: false };
    }
    return {
      p1: getAnchorCache(dim.anchor1),
      p2: getAnchorCache(dim.anchor2),
      frozen: true,
    };
  }

  // linear-h / linear-v
  const p1 = resolveAnchor(dim.anchor1, shapes);
  const p2 = resolveAnchor(dim.anchor2, shapes);
  if (p1 && p2) return { p1, p2, frozen: false };
  return {
    p1: p1 ?? getAnchorCache(dim.anchor1),
    p2: p2 ?? getAnchorCache(dim.anchor2),
    frozen: true,
  };
}
