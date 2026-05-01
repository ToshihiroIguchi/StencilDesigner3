import type { Polygon, Ring, Point } from '../types';
import { newId } from '../types';
import { normalizeAll } from '../normalize';
import { dist } from '../core/geometry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DxfEntity = any;

/** Convert mm to µm (integer). */
function mmToUm(v: number): number {
  return Math.round(v * 1000);
}

/** Approximate arc as polyline segments. Returns points in CCW order. */
function arcToPoints(cx: number, cy: number, r: number, startAngle: number, endAngle: number): Point[] {
  const points: Point[] = [];
  // Normalize angles
  let start = startAngle;
  let end = endAngle;
  if (end < start) end += 360;
  const span = end - start;
  const steps = Math.max(8, Math.ceil(Math.abs(span) / 5)); // ~5° per segment
  for (let i = 0; i <= steps; i++) {
    const angle = ((start + (span * i) / steps) * Math.PI) / 180;
    points.push({
      x: mmToUm(cx + r * Math.cos(angle)),
      y: mmToUm(cy + r * Math.sin(angle)),
    });
  }
  return points;
}

/** Chain a set of open segments into closed polylines. */
function chainSegments(segments: [Point, Point][]): Ring[] {
  if (segments.length === 0) return [];

  const SNAP = 10; // µm gap tolerance for chaining
  const used = new Array(segments.length).fill(false);
  const rings: Ring[] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    const chain: Point[] = [segments[start][0], segments[start][1]];
    used[start] = true;

    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const [a, b] = segments[i];
        if (dist(tail, a) <= SNAP) {
          chain.push(b);
          used[i] = true;
          extended = true;
          break;
        } else if (dist(tail, b) <= SNAP) {
          chain.push(a);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }

    if (chain.length >= 3 && dist(chain[0], chain[chain.length - 1]) <= SNAP) {
      chain.pop(); // Remove closing duplicate
      rings.push(chain);
    }
  }

  return rings;
}

/** Parse DXF text and return polygons. */
export async function importDxf(dxfText: string): Promise<Polygon[]> {
  // Dynamic import to avoid bundling issues
  const DxfParser = await import('dxf-parser');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new (DxfParser as any).default();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dxf: any;
  try {
    dxf = parser.parseSync(dxfText);
  } catch (e) {
    throw new Error(`DXF parse error: ${e}`);
  }

  const entities: DxfEntity[] = dxf?.entities ?? [];
  const segments: [Point, Point][] = [];
  const closedRings: Ring[] = [];

  for (const ent of entities) {
    switch (ent.type) {
      case 'LINE': {
        const a: Point = { x: mmToUm(ent.vertices[0].x), y: mmToUm(ent.vertices[0].y) };
        const b: Point = { x: mmToUm(ent.vertices[1].x), y: mmToUm(ent.vertices[1].y) };
        segments.push([a, b]);
        break;
      }

      case 'ARC': {
        const pts = arcToPoints(ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle);
        for (let i = 0; i < pts.length - 1; i++) {
          segments.push([pts[i], pts[i + 1]]);
        }
        break;
      }

      case 'CIRCLE': {
        const pts = arcToPoints(ent.center.x, ent.center.y, ent.radius, 0, 360);
        const ring: Ring = pts.slice(0, -1).map((p) => p);
        closedRings.push(ring);
        break;
      }

      case 'LWPOLYLINE': {
        const pts: Point[] = ent.vertices.map((v: { x: number; y: number }) => ({
          x: mmToUm(v.x),
          y: mmToUm(v.y),
        }));
        if (ent.shape || ent.closed) {
          closedRings.push(pts);
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            segments.push([pts[i], pts[i + 1]]);
          }
        }
        break;
      }

      case 'POLYLINE': {
        const pts: Point[] = (ent.vertices ?? []).map((v: { x: number; y: number }) => ({
          x: mmToUm(v.x),
          y: mmToUm(v.y),
        }));
        if (ent.shape || ent.closed) {
          closedRings.push(pts);
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            segments.push([pts[i], pts[i + 1]]);
          }
        }
        break;
      }
    }
  }

  // Chain open segments into rings
  const chained = chainSegments(segments);
  const allRings = [...closedRings, ...chained];

  const polygons: Polygon[] = allRings
    .filter((r) => r.length >= 3)
    .map((outer) => ({ id: newId(), outer, holes: [], layer: '0' }));

  return normalizeAll(polygons);
}
