// Conversion core for DWG import.
// Walks the DwgDatabase returned by LibreDWG, converts each entity into the
// intermediate representation (open segment list / closed ring list), and feeds
// it to buildImportResult.
//
// Coordinate convention: DWG is mm, Y-up. INSERT-expansion affine matrices are
// applied in mm space; µm rounding and the Y-flip happen only at the final step
// (CLAUDE.md: integer µm / Math.round required).
// Angles follow the DWG/libredwg convention (radians; verified empirically, spec
// §8). arcToPoints takes degrees, so we convert.

import type { Ring, Vertex } from '../types';
import { vertex } from '../core/vertex';
import { getCircleSegments } from '../core/geometry';
import { mmToUm, buildImportResult, type ImportResult } from '../dxf/importer';
import { getLibreDwg } from './libredwg';
import { flattenEntities, buildBlockMap, apply, type Mat } from './blocks';
import { Dwg_File_Type } from '@mlightcad/libredwg-web';
import type {
  DwgDatabase,
  DwgLineEntity,
  DwgArcEntity,
  DwgCircleEntity,
  DwgEllipseEntity,
  DwgSplineEntity,
  DwgLWPolylineEntity,
  DwgPolyline2dEntity,
  DwgPolyline3dEntity,
} from '@mlightcad/libredwg-web';

const RAD2DEG = 180 / Math.PI;

type Pt = { x: number; y: number };

/** Applies the matrix to an mm-space point, then rounds to µm and Y-flips into a Vertex. */
function toVertex(m: Mat, x: number, y: number): Vertex {
  const p = apply(m, x, y);
  return vertex(mmToUm(p.x), mmToUm(-p.y));
}

/** Converts an mm-space point list to Vertices via matrix apply + µm/Y-flip. */
function toVertices(m: Mat, pts: Pt[]): Vertex[] {
  return pts.map((p) => toVertex(m, p.x, p.y));
}

/**
 * Approximates an arc as an mm-space (Y-up) point list. Same angle convention as
 * importer's arcToPoints, but returns mm without the µm/Y-flip (the matrix is
 * applied later). startDeg/endDeg are in degrees.
 */
function arcPointsMm(cx: number, cy: number, r: number, startDeg: number, endDeg: number, ccw = true): Pt[] {
  const pts: Pt[] = [];
  let start = startDeg;
  let end = endDeg;
  if (ccw) {
    while (end < start) end += 360;
  } else {
    while (end > start) end -= 360;
  }
  const span = end - start;
  const fullCircleSegments = getCircleSegments(mmToUm(r));
  const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * fullCircleSegments));
  for (let i = 0; i <= steps; i++) {
    const angle = ((start + (span * i) / steps) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return pts;
}

/** Approximates a bulge segment p1→p2 as an mm-space point list (both ends inclusive). mm variant of the dxf/importer helper. */
function bulgeArcMm(p1x: number, p1y: number, p2x: number, p2y: number, bulge: number): Pt[] {
  const dx = p2x - p1x;
  const dy = p2y - p1y;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord < 1e-9) return [{ x: p1x, y: p1y }];

  const px = -dy / chord;
  const py = dx / chord;
  const sagitta = (bulge * chord) / 2;
  const r = (chord * chord / 4 + sagitta * sagitta) / (2 * Math.abs(sagitta));
  const perpOffset = Math.sign(bulge) * (r - Math.abs(sagitta));
  const cx = (p1x + p2x) / 2 + px * perpOffset;
  const cy = (p1y + p2y) / 2 + py * perpOffset;
  const startAngle = Math.atan2(p1y - cy, p1x - cx) * RAD2DEG;
  const endAngle = Math.atan2(p2y - cy, p2x - cx) * RAD2DEG;
  return arcPointsMm(cx, cy, r, startAngle, endAngle, bulge > 0);
}

/** Expands a polyline vertex list (with bulge support) into an mm-space point list. mm variant of dxf/importer's expandPolylineVerts. */
function expandVertsMm(verts: Array<{ x: number; y: number; bulge?: number }>, isClosed: boolean): Pt[] {
  const pts: Pt[] = [];
  const n = verts.length;
  if (n === 0) return pts;
  const segCount = isClosed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const bulge = v.bulge ?? 0;
    if (i >= segCount || Math.abs(bulge) < 1e-9) {
      pts.push({ x: v.x, y: v.y });
    } else {
      const nextV = verts[(i + 1) % n];
      const arc = bulgeArcMm(v.x, v.y, nextV.x, nextV.y, bulge);
      pts.push(...arc.slice(0, -1));
    }
  }
  return pts;
}

/**
 * Absolute chord-height tolerance for adaptive spline subdivision, in mm.
 * Matches the 0.5 µm max-chord-error used by getCircleSegments (0.5 µm = 0.0005 mm).
 * Applied for small curve spans where absolute sub-µm accuracy matters.
 */
const CHORD_TOL_ABS_MM = 0.0005;

/**
 * Relative chord-height tolerance (fraction of chord length).
 * A chord-height exceeding CHORD_TOL_REL × chord_length triggers subdivision.
 * 0.005 corresponds to a turn angle of ≈ 0.29° per chord, keeping vertex counts
 * in the tens-to-hundreds range for typical CAD splines spanning tens to hundreds
 * of mm, while still producing smooth curves at screen resolution.
 * The minimum is floored by CHORD_TOL_ABS_MM for sub-mm spans.
 */
const CHORD_TOL_REL = 0.005;

/**
 * Maximum recursion depth for adaptive subdivision.
 * At depth 16 a single span is split into at most 2^16 = 65536 sub-segments;
 * this cap prevents degenerate inputs from exploding.
 */
const ADAPTIVE_MAX_DEPTH = 16;

/**
 * Perpendicular distance from point M to the chord A–B.
 * All coordinates are in mm. Returns 0 when A and B coincide.
 */
function chordHeight(
  ax: number, ay: number,
  mx: number, my: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-24) return Math.sqrt((mx - ax) ** 2 + (my - ay) ** 2);
  // Cross-product magnitude / |AB|
  return Math.abs(dx * (ay - my) - dy * (ax - mx)) / Math.sqrt(len2);
}

/**
 * Returns the effective chord-height tolerance for a segment from (ax,ay) to (bx,by).
 * Uses the larger of the absolute tolerance and a relative fraction of the chord length,
 * so small spans get sub-µm accuracy while large spans get angle-based sampling.
 */
function chordTol(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  return Math.max(CHORD_TOL_ABS_MM, chordLen * CHORD_TOL_REL);
}

/**
 * Evaluates a clamped B-spline (or NURBS) curve in mm space using the de Boor algorithm.
 *
 * Returns an mm-space (Y-up) point list suitable for later matrix + µm rounding via toVertices.
 * Does NOT round — callers must not round inside Mm helpers (convention from arcPointsMm).
 *
 * Subdivision is adaptive: each parametric span is recursively bisected until the
 * midpoint chord-height error is within CHORD_TOL_MM (0.5 µm), so straight regions
 * produce few points while high-curvature regions produce more.
 *
 * @param degree      - B-spline degree p (≥1)
 * @param ctrlPts     - Control points in mm (DWG Y-up)
 * @param knots       - Knot vector; must have length === ctrlPts.length + degree + 1
 * @param weights     - Optional NURBS weights; when present must have length === ctrlPts.length
 * @param closed      - Whether the curve is closed (flag bit 1)
 * @returns           - Point list, or null when inputs are malformed
 */
export function bsplinePointsMm(
  degree: number,
  ctrlPts: Array<{ x: number; y: number }>,
  knots: number[],
  weights: number[] | undefined,
  closed: boolean,
): Pt[] | null {
  const n = ctrlPts.length;
  if (n < 2 || degree < 1 || knots.length !== n + degree + 1) return null;

  const isRational = weights !== undefined && weights.length === n;

  // Parameter domain for a clamped knot vector: [knots[p], knots[n]]
  const tMin = knots[degree];
  const tMax = knots[n];
  if (tMax - tMin < 1e-12) return null;

  /** de Boor's algorithm: evaluates the B-spline at parameter t. */
  function deBoor(t: number): Pt {
    // Find the knot span index k such that knots[k] <= t < knots[k+1].
    // Clamp t to [tMin, tMax] and handle the right endpoint specially.
    const tClamped = Math.min(Math.max(t, tMin), tMax);
    let k = degree;
    for (let i = degree; i < n; i++) {
      if (knots[i] <= tClamped && tClamped < knots[i + 1]) { k = i; break; }
      if (i === n - 1) k = i; // tClamped === tMax (right endpoint)
    }

    // Homogeneous de Boor: carry (wx, wy, w) when rational.
    const dx = new Float64Array(degree + 1);
    const dy = new Float64Array(degree + 1);
    const dw = new Float64Array(degree + 1);
    for (let j = 0; j <= degree; j++) {
      const idx = k - degree + j;
      const w = isRational ? weights![idx] : 1.0;
      dx[j] = ctrlPts[idx].x * w;
      dy[j] = ctrlPts[idx].y * w;
      dw[j] = w;
    }

    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const denom = knots[i + degree - r + 1] - knots[i];
        const alpha = denom < 1e-12 ? 0 : (tClamped - knots[i]) / denom;
        dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
        dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
        dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
      }
    }

    const wFinal = dw[degree];
    return wFinal < 1e-14
      ? { x: dx[degree], y: dy[degree] }
      : { x: dx[degree] / wFinal, y: dy[degree] / wFinal };
  }

  /**
   * Adaptively subdivides the parameter interval [t0, t1] with known curve values
   * at the endpoints (p0, p1). Pushes intermediate points into `out` (not the endpoints).
   * Uses chordTol() so small spans get absolute µm accuracy and large spans get
   * angle-based sampling (preventing over-densification for large-scale curves).
   */
  function subdivide(
    t0: number, p0: Pt,
    t1: number, p1: Pt,
    depth: number,
    out: Pt[],
  ): void {
    if (depth >= ADAPTIVE_MAX_DEPTH) return;
    const tMid = (t0 + t1) * 0.5;
    const pMid = deBoor(tMid);
    if (chordHeight(p0.x, p0.y, pMid.x, pMid.y, p1.x, p1.y) > chordTol(p0.x, p0.y, p1.x, p1.y)) {
      subdivide(t0, p0, tMid, pMid, depth + 1, out);
      out.push(pMid);
      subdivide(tMid, pMid, t1, p1, depth + 1, out);
    }
  }

  // Collect unique knot values to define the B-spline spans.
  // Each distinct interval [knots[i], knots[i+1]] is one span; adaptively subdivide each.
  const uniqueKnots: number[] = [];
  for (let i = degree; i <= n; i++) {
    const k = knots[i];
    if (uniqueKnots.length === 0 || k - uniqueKnots[uniqueKnots.length - 1] > 1e-12) {
      uniqueKnots.push(k);
    }
  }

  const pts: Pt[] = [];
  for (let si = 0; si < uniqueKnots.length - 1; si++) {
    const t0 = uniqueKnots[si];
    const t1 = uniqueKnots[si + 1];
    const p0 = deBoor(t0);
    const p1 = deBoor(t1);
    // Push span start (skip duplicate of previous span's end for si > 0).
    if (si === 0) pts.push(p0);
    subdivide(t0, p0, t1, p1, 0, pts);
    pts.push(p1);
  }

  // Fallback: if no unique spans found, at minimum include the endpoints.
  if (pts.length === 0) {
    pts.push(deBoor(tMin));
    pts.push(deBoor(tMax));
  }

  // For closed curves, ensure the last point equals the first.
  if (closed && pts.length > 1) {
    pts[pts.length - 1] = pts[0];
  }

  return pts;
}

/**
 * Interpolates a smooth curve through the given fit points using centripetal
 * Catmull-Rom splines (alpha = 0.5).
 *
 * Returns an mm-space (Y-up) point list.  Does NOT round.
 *
 * Subdivision is adaptive per span: each span [s, s+1] is recursively bisected
 * until the midpoint chord-height error is within CHORD_TOL_MM (0.5 µm), so
 * straight spans produce few points while curved spans produce more.  Every fit
 * point is included as an exact vertex.
 *
 * @param fitPts  - Points the curve must pass through exactly, in mm
 * @param closed  - Whether the curve is closed
 * @returns       - Densified point list passing through every fit point
 */
export function fitSplinePointsMm(
  fitPts: Array<{ x: number; y: number }>,
  closed: boolean,
): Pt[] {
  const n = fitPts.length;
  if (n < 2) return fitPts.map((p) => ({ x: p.x, y: p.y }));
  if (n === 2) {
    // Only two points: straight line.
    return [
      { x: fitPts[0].x, y: fitPts[0].y },
      { x: fitPts[1].x, y: fitPts[1].y },
    ];
  }

  /** Centripetal Catmull-Rom knot increment (alpha = 0.5). */
  function knotInc(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.pow(dx * dx + dy * dy, 0.25); // sqrt of Euclidean dist (alpha=0.5)
  }

  /** Evaluates a Catmull-Rom segment at parameter t ∈ [0,1] given four control points. */
  function catmullRomAt(
    p0x: number, p0y: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    p3x: number, p3y: number,
    t: number,
  ): Pt {
    // Barry–Goldman centripetal parameterisation
    const t0 = 0;
    const t1 = t0 + knotInc(p0x, p0y, p1x, p1y);
    const t2 = t1 + knotInc(p1x, p1y, p2x, p2y);
    const t3 = t2 + knotInc(p2x, p2y, p3x, p3y);
    const tc = t1 + (t2 - t1) * t; // map t ∈ [0,1] to [t1, t2]

    function interp(ax: number, bx: number, ta: number, tb: number, tv: number): number {
      const d = tb - ta;
      return d < 1e-12 ? ax : ax + (bx - ax) * (tv - ta) / d;
    }
    const a1x = interp(p0x, p1x, t0, t1, tc);
    const a1y = interp(p0y, p1y, t0, t1, tc);
    const a2x = interp(p1x, p2x, t1, t2, tc);
    const a2y = interp(p1y, p2y, t1, t2, tc);
    const a3x = interp(p2x, p3x, t2, t3, tc);
    const a3y = interp(p2y, p3y, t2, t3, tc);

    const b1x = interp(a1x, a2x, t0, t2, tc);
    const b1y = interp(a1y, a2y, t0, t2, tc);
    const b2x = interp(a2x, a3x, t1, t3, tc);
    const b2y = interp(a2y, a3y, t1, t3, tc);

    return {
      x: interp(b1x, b2x, t1, t2, tc),
      y: interp(b1y, b2y, t1, t2, tc),
    };
  }

  /** Returns the i-th fit point with wrapping for closed curves, or extrapolation for open ends. */
  function getPoint(i: number): { x: number; y: number } {
    if (closed) {
      return fitPts[((i % n) + n) % n];
    }
    // Open: clamp to valid range by reflecting the ghost point.
    if (i < 0) return { x: 2 * fitPts[0].x - fitPts[1].x, y: 2 * fitPts[0].y - fitPts[1].y };
    if (i >= n) return { x: 2 * fitPts[n - 1].x - fitPts[n - 2].x, y: 2 * fitPts[n - 1].y - fitPts[n - 2].y };
    return fitPts[i];
  }

  /**
   * Adaptively subdivides a single Catmull-Rom span (t ∈ [0,1]) between fit points
   * s and s+1.  Pushes intermediate points (not the endpoints) into `out`.
   * Uses chordTol() so small spans get absolute µm accuracy and large spans get
   * angle-based sampling (preventing over-densification for large-scale curves).
   */
  function subdivideSpan(
    s: number,
    t0: number, pt0: Pt,
    t1: number, pt1: Pt,
    depth: number,
    out: Pt[],
  ): void {
    if (depth >= ADAPTIVE_MAX_DEPTH) return;
    const pp0 = getPoint(s - 1);
    const pp1 = getPoint(s);
    const pp2 = getPoint(s + 1);
    const pp3 = getPoint(s + 2);
    const tMid = (t0 + t1) * 0.5;
    const ptMid = catmullRomAt(pp0.x, pp0.y, pp1.x, pp1.y, pp2.x, pp2.y, pp3.x, pp3.y, tMid);
    if (chordHeight(pt0.x, pt0.y, ptMid.x, ptMid.y, pt1.x, pt1.y) > chordTol(pt0.x, pt0.y, pt1.x, pt1.y)) {
      subdivideSpan(s, t0, pt0, tMid, ptMid, depth + 1, out);
      out.push(ptMid);
      subdivideSpan(s, tMid, ptMid, t1, pt1, depth + 1, out);
    }
  }

  const spanCount = closed ? n : n - 1;
  const pts: Pt[] = [];

  for (let s = 0; s < spanCount; s++) {
    const pp0 = getPoint(s - 1);
    const pp1 = getPoint(s);
    const pp2 = getPoint(s + 1);
    const pp3 = getPoint(s + 2);

    // The fit point at index s is the exact start of this span (t = 0).
    const spanStart: Pt = { x: pp1.x, y: pp1.y };
    // The fit point at index s+1 is the exact end of this span (t = 1).
    const spanEnd: Pt = { x: pp2.x, y: pp2.y };

    // Push the exact span-start fit point.
    pts.push(spanStart);

    // Evaluate the midpoint with the full four-control-point context, then subdivide.
    const tMid = 0.5;
    const ptMid = catmullRomAt(pp0.x, pp0.y, pp1.x, pp1.y, pp2.x, pp2.y, pp3.x, pp3.y, tMid);
    if (chordHeight(spanStart.x, spanStart.y, ptMid.x, ptMid.y, spanEnd.x, spanEnd.y) > chordTol(spanStart.x, spanStart.y, spanEnd.x, spanEnd.y)) {
      subdivideSpan(s, 0, spanStart, tMid, ptMid, 1, pts);
      pts.push(ptMid);
      subdivideSpan(s, tMid, ptMid, 1, spanEnd, 1, pts);
    }
  }

  // Close the output: add the last fit point (or first for closed).
  pts.push(closed
    ? { x: fitPts[0].x, y: fitPts[0].y }
    : { x: fitPts[n - 1].x, y: fitPts[n - 1].y });

  return pts;
}

/** Approximates an ellipse (arc) as an mm-space point list. startRad/endRad are parametric angles (radians). */
function ellipsePointsMm(
  cx: number, cy: number,
  majorX: number, majorY: number,
  axisRatio: number,
  startRad: number, endRad: number,
): Pt[] {
  const majorLen = Math.sqrt(majorX * majorX + majorY * majorY);
  const minorLen = majorLen * axisRatio;
  const tilt = Math.atan2(majorY, majorX);
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);

  let start = startRad;
  let end = endRad;
  while (end <= start) end += 2 * Math.PI;
  const span = end - start;
  const fullSegments = getCircleSegments(mmToUm(majorLen));
  const steps = Math.max(2, Math.ceil((span / (2 * Math.PI)) * fullSegments));

  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (span * i) / steps;
    const lx = majorLen * Math.cos(t);
    const ly = minorLen * Math.sin(t);
    pts.push({ x: cx + lx * cosT - ly * sinT, y: cy + lx * sinT + ly * cosT });
  }
  return pts;
}

/** Builds consecutive segments [Vi, Vi+1] from a point list and pushes them into segments. */
function pushSegments(
  verts: Vertex[],
  layer: string,
  segments: Array<{ seg: [Vertex, Vertex]; layer: string }>,
): void {
  for (let i = 0; i < verts.length - 1; i++) {
    segments.push({ seg: [verts[i], verts[i + 1]], layer });
  }
}

/**
 * Pure function (WASM-independent) that converts a parsed DwgDatabase into an
 * ImportResult. Called by importDwg, and usable directly in tests by passing a DB.
 */
export function convertDwgDatabase(db: DwgDatabase): ImportResult {
  const segments: Array<{ seg: [Vertex, Vertex]; layer: string }> = [];
  const closedRings: Array<{ ring: Ring; layer: string }> = [];
  const ignoredCounts: Record<string, number> = {};

  const blockMap = buildBlockMap(db.tables?.BLOCK_RECORD?.entries ?? []);
  const placed = flattenEntities(db.entities ?? [], blockMap);

  for (const { entity, matrix } of placed) {
    const layer = entity.layer ?? '0';
    try {
      switch (entity.type) {
        case 'LINE': {
          const e = entity as DwgLineEntity;
          const a = toVertex(matrix, e.startPoint.x, e.startPoint.y);
          const b = toVertex(matrix, e.endPoint.x, e.endPoint.y);
          segments.push({ seg: [a, b], layer });
          break;
        }
        case 'LWPOLYLINE': {
          const e = entity as DwgLWPolylineEntity;
          const isClosed = !!(e.flag & 1);
          const mm = expandVertsMm(e.vertices ?? [], isClosed);
          const verts = toVertices(matrix, mm);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
          break;
        }
        case 'POLYLINE2D': {
          const e = entity as DwgPolyline2dEntity;
          const isClosed = !!(e.flag & 1);
          const mm = expandVertsMm(e.vertices ?? [], isClosed);
          const verts = toVertices(matrix, mm);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
          break;
        }
        case 'POLYLINE3D': {
          const e = entity as DwgPolyline3dEntity;
          const isClosed = !!(e.flag & 1);
          // 3D polyline: ignore z, no bulge
          const mm: Pt[] = (e.vertices ?? []).map((v) => ({ x: v.x, y: v.y }));
          const verts = toVertices(matrix, mm);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
          break;
        }
        case 'ARC': {
          const e = entity as DwgArcEntity;
          const mm = arcPointsMm(e.center.x, e.center.y, e.radius, e.startAngle * RAD2DEG, e.endAngle * RAD2DEG, true);
          pushSegments(toVertices(matrix, mm), layer, segments);
          break;
        }
        case 'CIRCLE': {
          const e = entity as DwgCircleEntity;
          const mm = arcPointsMm(e.center.x, e.center.y, e.radius, 0, 360, true);
          const verts = toVertices(matrix, mm.slice(0, -1)); // drop the duplicate start point to form a ring
          closedRings.push({ ring: verts, layer });
          break;
        }
        case 'ELLIPSE': {
          const e = entity as DwgEllipseEntity;
          const full = Math.abs((e.endAngle - e.startAngle) - 2 * Math.PI) < 1e-6
            || Math.abs(e.endAngle - e.startAngle) < 1e-9;
          const mm = ellipsePointsMm(
            e.center.x, e.center.y,
            e.majorAxisEndPoint.x, e.majorAxisEndPoint.y,
            e.axisRatio,
            e.startAngle, full ? e.startAngle + 2 * Math.PI : e.endAngle,
          );
          if (full) {
            closedRings.push({ ring: toVertices(matrix, mm.slice(0, -1)), layer });
          } else {
            pushSegments(toVertices(matrix, mm), layer, segments);
          }
          break;
        }
        case 'SPLINE': {
          const e = entity as DwgSplineEntity;
          const isClosed = !!(e.flag & 1);
          let mm: Pt[] | null = null;

          // Path 1: proper B-spline / NURBS via de Boor, when knot vector is present.
          if ((e.controlPoints?.length ?? 0) >= 2
            && e.knots?.length === (e.controlPoints.length + e.degree + 1)) {
            mm = bsplinePointsMm(
              e.degree,
              e.controlPoints.map((p) => ({ x: p.x, y: p.y })),
              e.knots,
              e.weights,
              isClosed,
            );
          }

          // Path 2: centripetal Catmull-Rom through fit points, when B-spline unavailable.
          if (mm === null && (e.fitPoints?.length ?? 0) >= 2) {
            mm = fitSplinePointsMm(
              e.fitPoints.map((p) => ({ x: p.x, y: p.y })),
              isClosed,
            );
          }

          // Path 3: fallback — straight chords through whatever points are available.
          if (mm === null) {
            const src = (e.fitPoints?.length ?? 0) >= 2 ? e.fitPoints : (e.controlPoints ?? []);
            if (src.length < 2) break;
            mm = src.map((p) => ({ x: p.x, y: p.y }));
          }

          if (mm.length < 2) break;
          const verts = toVertices(matrix, mm);
          if (isClosed) {
            // Drop the duplicate closing point added by the helpers before pushing as a ring.
            const ring = (verts.length > 1
              && verts[0].x === verts[verts.length - 1].x
              && verts[0].y === verts[verts.length - 1].y)
              ? verts.slice(0, -1)
              : verts;
            closedRings.push({ ring, layer });
          } else {
            pushSegments(verts, layer, segments);
          }
          break;
        }
        default: {
          ignoredCounts[entity.type] = (ignoredCounts[entity.type] ?? 0) + 1;
          break;
        }
      }
    } catch {
      // A single entity conversion failure must not stop the whole import; only count it.
      ignoredCounts['_error'] = (ignoredCounts['_error'] ?? 0) + 1;
    }
  }

  // Convert the LAYER table into the rawLayers shape expected by buildImportResult.
  const rawLayers = (db.tables?.LAYER?.entries ?? []).map((l) => ({
    name: l.name,
    // off / negative colorIndex means hidden. buildImportResult derives visibility from the colorIndex sign.
    colorIndex: l.off ? -Math.abs(l.colorIndex ?? 7) : (l.colorIndex ?? 7),
    frozen: !!l.frozen,
    lineType: l.lineType,
    lineweight: l.lineweight,
    locked: !!l.locked,
    plot: l.plotFlag !== 0,
  }));

  const result = buildImportResult(segments, closedRings, rawLayers);
  return { ...result, ignoredCounts: { ...result.ignoredCounts, ...ignoredCounts } };
}

/** Parses a DWG file (ArrayBuffer) and returns an ImportResult. */
export async function importDwg(buf: ArrayBuffer): Promise<ImportResult> {
  const lib = await getLibreDwg();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dwg: any;
  try {
    // The returned error is a bit flag; treat it as success as long as entities were read (low bits are warnings).
    dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG);
    const db: DwgDatabase = lib.convert(dwg);
    return convertDwgDatabase(db);
  } finally {
    if (dwg !== undefined) {
      try {
        lib.dwg_free(dwg);
      } catch {
        // Freeing failure is non-fatal; ignore.
      }
    }
  }
}
