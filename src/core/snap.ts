import type { Point, Polygon, Ring } from '../types';
import { dist, isRingCircleLike, ringCentroid, midpoint, snapToGrid, snapToGridShifted } from './geometry';

export type SnapKind = 'grid' | 'vertex' | 'midpoint' | 'center' | 'edge';

export type SnapRef =
  | { kind: 'vertex'; shapeId: string; ringIndex: number; vertexId: string }
  | { kind: 'midpoint'; shapeId: string; ringIndex: number; edgeStartId: string; edgeEndId: string }
  | { kind: 'center'; shapeId: string; ringIndex: number }
  | { kind: 'edge'; shapeId: string; ringIndex: number; edgeStartId: string; edgeEndId: string; t: number };

export interface SnapResult {
  point: Point;
  kind: SnapKind;
  ref?: SnapRef; // undefined when kind === 'grid'
}

function nearestOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: { x: a.x, y: a.y }, t: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { point: { x: Math.round(a.x + t * dx), y: Math.round(a.y + t * dy) }, t };
}

function rings(shape: Polygon): { ring: Ring; ringIndex: number }[] {
  return [
    { ring: shape.outer, ringIndex: -1 },
    ...shape.holes.map((h, i) => ({ ring: h, ringIndex: i })),
  ];
}

/**
 * Find the best snap point for worldPt.
 *
 * Priority (two-tier):
 *   Tier 1 — center / vertex / midpoint (all compete; whichever is closest wins)
 *   Tier 2 — nearest point on any edge (only when Tier 1 found nothing within snapRadius)
 *   Tier 3 — grid snap
 */
export function findSnap(
  worldPt: Point,
  shapes: Polygon[],
  gridSize: number,
  snapRadius: number,
  excludeShapeId?: string,
  gridOrigin?: Point,
): SnapResult {
  let best: SnapResult = { point: worldPt, kind: 'grid' };
  let bestDist = snapRadius;

  // ── Tier 1 ──
  for (const shape of shapes) {
    if (shape.id === excludeShapeId) continue;
    for (const { ring, ringIndex } of rings(shape)) {
      if (isRingCircleLike(ring)) {
        const c = ringCentroid(ring);
        const d = dist(worldPt, c);
        if (d < bestDist) {
          bestDist = d;
          best = { point: c, kind: 'center', ref: { kind: 'center', shapeId: shape.id, ringIndex } };
        }
      }
      for (const v of ring) {
        const d = dist(worldPt, { x: v.x, y: v.y });
        if (d < bestDist) {
          bestDist = d;
          best = { point: { x: v.x, y: v.y }, kind: 'vertex', ref: { kind: 'vertex', shapeId: shape.id, ringIndex, vertexId: v.id } };
        }
      }
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const mp = midpoint(a, b);
        const d = dist(worldPt, mp);
        if (d < bestDist) {
          bestDist = d;
          best = { point: mp, kind: 'midpoint', ref: { kind: 'midpoint', shapeId: shape.id, ringIndex, edgeStartId: a.id, edgeEndId: b.id } };
        }
      }
    }
  }
  if (bestDist < snapRadius) return best;

  // ── Tier 2: edge nearest point ──
  for (const shape of shapes) {
    if (shape.id === excludeShapeId) continue;
    for (const { ring, ringIndex } of rings(shape)) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const { point: np, t } = nearestOnSegment(worldPt, a, b);
        const d = dist(worldPt, np);
        if (d < bestDist) {
          bestDist = d;
          best = { point: np, kind: 'edge', ref: { kind: 'edge', shapeId: shape.id, ringIndex, edgeStartId: a.id, edgeEndId: b.id, t } };
        }
      }
    }
  }
  if (bestDist < snapRadius) return best;

  return { point: gridOrigin ? snapToGridShifted(worldPt, gridSize, gridOrigin) : snapToGrid(worldPt, gridSize), kind: 'grid' };
}

export interface SelectionSnapResult {
  delta: { x: number; y: number }; // Snapped translation vector
  kind: SnapKind;
  movingPoint?: Point;             // Vertex on the moving shape that snapped
  targetPoint?: Point;             // target point on the stationary shape/grid
  ref?: SnapRef;                   // Snapping reference on the static shape
}

export function findSelectionSnap(
  movingShapes: Polygon[],
  dragStartWorld: Point,
  currentMouseWorld: Point,
  staticShapes: Polygon[],
  gridSize: number,
  snapRadius: number,
  gridOrigin?: Point,
): SelectionSnapResult {
  const rawDx = currentMouseWorld.x - dragStartWorld.x;
  const rawDy = currentMouseWorld.y - dragStartWorld.y;

  // Collect all unique vertices from moving shapes' outer rings
  const movingVertices: Point[] = [];
  const seen = new Set<string>();
  for (const shape of movingShapes) {
    for (const v of shape.outer) {
      const key = `${v.x},${v.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        movingVertices.push({ x: v.x, y: v.y });
      }
    }
  }

  let bestCandidate: {
    movingPt: Point;
    snapRes: SnapResult;
    dist: number;
  } | null = null;

  let bestDist = snapRadius;

  if (staticShapes.length > 0) {
    for (const v of movingVertices) {
      // Find where this vertex would end up under raw mouse dragging
      const vDragged = {
        x: Math.round(v.x + rawDx),
        y: Math.round(v.y + rawDy),
      };

      // Check if this dragged vertex snaps to any static shape within snapRadius
      const snapRes = findSnap(vDragged, staticShapes, gridSize, snapRadius, undefined, gridOrigin);
      if (snapRes.kind !== 'grid') {
        const d = dist(vDragged, snapRes.point);
        if (d < bestDist) {
          bestDist = d;
          bestCandidate = {
            movingPt: v,
            snapRes,
            dist: d,
          };
        }
      }
    }
  }

  // If we found a valid vertex-to-vertex/edge/center/midpoint snap, align it!
  if (bestCandidate) {
    const targetPt = bestCandidate.snapRes.point;
    const movingPt = bestCandidate.movingPt;
    const deltaX = Math.round(targetPt.x - movingPt.x);
    const deltaY = Math.round(targetPt.y - movingPt.y);

    return {
      delta: { x: deltaX, y: deltaY },
      kind: bestCandidate.snapRes.kind,
      movingPoint: movingPt,
      targetPoint: targetPt,
      ref: bestCandidate.snapRes.ref,
    };
  }

  // Otherwise, fall back to mouse grid snapping
  const snappedMouse = gridOrigin ? snapToGridShifted(currentMouseWorld, gridSize, gridOrigin) : snapToGrid(currentMouseWorld, gridSize);
  const deltaX = Math.round(snappedMouse.x - dragStartWorld.x);
  const deltaY = Math.round(snappedMouse.y - dragStartWorld.y);

  return {
    delta: { x: deltaX, y: deltaY },
    kind: 'grid',
  };
}

