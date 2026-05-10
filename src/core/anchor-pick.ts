import type { Polygon, Point, DimensionAnchor, Vertex } from '../types';

function sqDist(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/**
 * Find the nearest vertex across all shapes within pixelRadius (world units).
 * Returns a 'vertex' DimensionAnchor or null if nothing is close enough.
 */
export function findVertexAnchor(
  worldPt: Point,
  shapes: Polygon[],
  worldRadius: number,
): DimensionAnchor | null {
  const radiusSq = worldRadius * worldRadius;
  let best: { dist: number; anchor: DimensionAnchor } | null = null;

  for (const shape of shapes) {
    const rings: { ring: Vertex[]; ringIndex: number }[] = [
      { ring: shape.outer, ringIndex: -1 },
      ...shape.holes.map((h, i) => ({ ring: h, ringIndex: i })),
    ];
    for (const { ring, ringIndex } of rings) {
      for (const v of ring) {
        const d = sqDist(worldPt, v);
        if (d <= radiusSq && (!best || d < best.dist)) {
          best = {
            dist: d,
            anchor: {
              kind: 'vertex',
              shapeId: shape.id,
              ringIndex,
              vertexId: v.id,
              cachedPoint: { x: v.x, y: v.y },
            },
          };
        }
      }
    }
  }

  return best?.anchor ?? null;
}

/** Squared distance from point P to segment AB. */
function sqDistToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return sqDist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  return sqDist(p, { x: a.x + t * abx, y: a.y + t * aby });
}

/**
 * Find the nearest edge across all shapes within pixelRadius (world units).
 * Returns an 'edge' DimensionAnchor with cachedPoint = edge midpoint, or null.
 */
export function findEdgeAnchor(
  worldPt: Point,
  shapes: Polygon[],
  worldRadius: number,
): DimensionAnchor | null {
  const radiusSq = worldRadius * worldRadius;
  let best: { dist: number; anchor: DimensionAnchor } | null = null;

  for (const shape of shapes) {
    const rings: { ring: Vertex[]; ringIndex: number }[] = [
      { ring: shape.outer, ringIndex: -1 },
      ...shape.holes.map((h, i) => ({ ring: h, ringIndex: i })),
    ];
    for (const { ring, ringIndex } of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const d = sqDistToSegment(worldPt, a, b);
        if (d <= radiusSq && (!best || d < best.dist)) {
          const mid: Point = {
            x: Math.round((a.x + b.x) / 2),
            y: Math.round((a.y + b.y) / 2),
          };
          best = {
            dist: d,
            anchor: {
              kind: 'edge',
              shapeId: shape.id,
              ringIndex,
              edgeStartId: a.id,
              edgeEndId: b.id,
              cachedPoint: mid,
            },
          };
        }
      }
    }
  }

  return best?.anchor ?? null;
}
