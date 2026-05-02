import type { Point, Ring, Polygon } from '../types';
import { newId } from '../types';
import { normalize, bbox, area } from '../normalize';

/** Approximate a circle as a polygon with N sides (default 64). */
export function circleToPolygon(cx: number, cy: number, r: number, sides = 64): Polygon {
  const outer: Ring = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    outer.push({
      x: Math.round(cx + r * Math.cos(angle)),
      y: Math.round(cy + r * Math.sin(angle)),
    });
  }
  return normalize({ id: newId(), outer, holes: [], layer: '0' });
}

/** Create a rectangle polygon from two corner points. */
export function rectToPolygon(x1: number, y1: number, x2: number, y2: number): Polygon {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const maxX = Math.max(x1, x2);
  const maxY = Math.max(y1, y2);
  const outer: Ring = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  return normalize({ id: newId(), outer, holes: [], layer: '0' });
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

/** Translate a ring by (dx, dy). */
export function translateRing(ring: Ring, dx: number, dy: number): Ring {
  return ring.map((p) => ({ x: p.x + dx, y: p.y + dy }));
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

/** Deep clone a polygon with a new ID. */
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
