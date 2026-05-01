// Boolean operations using clipper-lib (local npm bundle, no CDN required).
// Scale factor 100 converts integer µm to Clipper's fixed-point integers.

import type { Polygon, Ring } from '../types';
import { newId } from '../types';
import { normalize } from '../normalize';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as ClipperLib from 'clipper-lib';

const SCALE = 100;

type ClipperPoint = { X: number; Y: number };
type ClipperPath = ClipperPoint[];

function toClipperPath(ring: Ring): ClipperPath {
  return ring.map((p) => ({ X: p.x * SCALE, Y: p.y * SCALE }));
}

function fromClipperPath(path: ClipperPath): Ring {
  return path.map((p) => ({ x: Math.round(p.X / SCALE), y: Math.round(p.Y / SCALE) }));
}

function toClipperPaths(polygon: Polygon): ClipperPath[] {
  return [toClipperPath(polygon.outer), ...polygon.holes.map(toClipperPath)];
}

function clipperResultToPolygons(solution: ClipperPath[], layer: string): Polygon[] {
  if (!solution || solution.length === 0) return [];

  const outerPaths: ClipperPath[] = [];
  const holePaths: ClipperPath[] = [];

  for (const path of solution) {
    if (path.length < 3) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (ClipperLib as any).Clipper.Area(path);
    if (a > 0) {
      outerPaths.push(path);
    } else {
      holePaths.push(path);
    }
  }

  const polys: Polygon[] = [];
  for (const outer of outerPaths) {
    const ring = fromClipperPath(outer);
    const holes: Ring[] = [];
    for (const hole of holePaths) {
      const testPt = hole[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((ClipperLib as any).Clipper.PointInPolygon({ X: testPt.X, Y: testPt.Y }, outer) !== 0) {
        holes.push(fromClipperPath(hole));
      }
    }
    try {
      polys.push(normalize({ id: newId(), outer: ring, holes, layer }));
    } catch {
      // Degenerate result - skip
    }
  }

  return polys;
}

function runClipper(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number
): ClipperPath[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = ClipperLib as any;
  const cpr = new C.Clipper();
  cpr.AddPaths(subjectPaths, C.PolyType.ptSubject, true);
  cpr.AddPaths(clipPaths, C.PolyType.ptClip, true);
  const solution: ClipperPath[] = [];
  cpr.Execute(clipType, solution, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return solution;
}

/** Union multiple polygons into one or more result polygons. */
export function union(polygons: Polygon[]): Polygon[] {
  if (polygons.length === 0) return [];
  if (polygons.length === 1) return [polygons[0]];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = ClipperLib as any;
  const layer = polygons[0].layer;
  const subjectPaths = polygons.flatMap(toClipperPaths);

  const cpr = new C.Clipper();
  cpr.AddPaths(subjectPaths, C.PolyType.ptSubject, true);
  const solution: ClipperPath[] = [];
  cpr.Execute(
    C.ClipType.ctUnion,
    solution,
    C.PolyFillType.pftNonZero,
    C.PolyFillType.pftNonZero
  );

  return clipperResultToPolygons(solution, layer);
}

/** Subtract polygon b from polygon a. */
export function difference(a: Polygon, b: Polygon): Polygon[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = ClipperLib as any;
  const solution = runClipper(
    toClipperPaths(a),
    toClipperPaths(b),
    C.ClipType.ctDifference
  );
  return clipperResultToPolygons(solution, a.layer);
}

/** Intersect two polygons. */
export function intersection(a: Polygon, b: Polygon): Polygon[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = ClipperLib as any;
  const solution = runClipper(
    toClipperPaths(a),
    toClipperPaths(b),
    C.ClipType.ctIntersection
  );
  return clipperResultToPolygons(solution, a.layer);
}
