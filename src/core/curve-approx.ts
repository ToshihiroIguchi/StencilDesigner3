// Common curve approximation utilities in mm space (Y-up).
// Shared between DXF and DWG importers.
// Output points are floating-point mm coordinates; affine matrices and µm integer rounding
// (with Y-flip) are applied downstream by the callers.

import { getCircleSegments } from './geometry';

export type Pt = { x: number; y: number };

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

/** Convert mm value to integer µm using Math.round. */
export function mmToUm(v: number): number {
  return Math.round(v * 1000);
}

/**
 * Approximates an arc as an mm-space (Y-up) point list.
 * startDeg/endDeg are in degrees [0, 360).
 */
export function arcPointsMm(
  cx: number, cy: number, r: number,
  startDeg: number, endDeg: number,
  ccw = true
): Pt[] {
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

/** Approximates a bulge segment p1→p2 as an mm-space point list (both ends inclusive). */
export function bulgeArcMm(p1x: number, p1y: number, p2x: number, p2y: number, bulge: number): Pt[] {
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

/** Expands a polyline vertex list (with bulge support) into an mm-space point list. */
export function expandVertsMm(
  verts: Array<{ x: number; y: number; bulge?: number }>,
  isClosed: boolean
): Pt[] {
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

const CHORD_TOL_ABS_MM = 0.0005; // 0.5 µm
const CHORD_TOL_REL = 0.005;
const ADAPTIVE_MAX_DEPTH = 16;

function chordHeight(
  ax: number, ay: number,
  mx: number, my: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-24) return Math.sqrt((mx - ax) ** 2 + (my - ay) ** 2);
  return Math.abs(dx * (ay - my) - dy * (ax - mx)) / Math.sqrt(len2);
}

function chordTol(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  return Math.max(CHORD_TOL_ABS_MM, chordLen * CHORD_TOL_REL);
}

/**
 * Evaluates a B-spline (or NURBS) curve in mm space using de Boor's algorithm.
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
  const tMin = knots[degree];
  const tMax = knots[n];
  if (tMax - tMin < 1e-12) return null;

  function deBoor(t: number): Pt {
    const tClamped = Math.min(Math.max(t, tMin), tMax);
    let k = degree;
    for (let i = degree; i < n; i++) {
      if (knots[i] <= tClamped && tClamped < knots[i + 1]) { k = i; break; }
      if (i === n - 1) k = i;
    }

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
    if (si === 0) pts.push(p0);
    subdivide(t0, p0, t1, p1, 0, pts);
    pts.push(p1);
  }

  if (pts.length === 0) {
    pts.push(deBoor(tMin));
    pts.push(deBoor(tMax));
  }

  if (closed && pts.length > 1) {
    pts[pts.length - 1] = pts[0];
  }

  return pts;
}

/**
 * Centripetal Catmull-Rom interpolation through fit points.
 */
export function fitSplinePointsMm(
  fitPts: Array<{ x: number; y: number }>,
  closed: boolean,
): Pt[] {
  const n = fitPts.length;
  if (n < 2) return fitPts.map((p) => ({ x: p.x, y: p.y }));
  if (n === 2) {
    return [
      { x: fitPts[0].x, y: fitPts[0].y },
      { x: fitPts[1].x, y: fitPts[1].y },
    ];
  }

  function knotInc(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.pow(dx * dx + dy * dy, 0.25);
  }

  function catmullRomAt(
    p0x: number, p0y: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    p3x: number, p3y: number,
    t: number,
  ): Pt {
    const t0 = 0;
    const t1 = t0 + knotInc(p0x, p0y, p1x, p1y);
    const t2 = t1 + knotInc(p1x, p1y, p2x, p2y);
    const t3 = t2 + knotInc(p2x, p2y, p3x, p3y);
    const tc = t1 + (t2 - t1) * t;

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

  function getPoint(i: number): { x: number; y: number } {
    if (closed) {
      return fitPts[((i % n) + n) % n];
    }
    if (i < 0) return { x: 2 * fitPts[0].x - fitPts[1].x, y: 2 * fitPts[0].y - fitPts[1].y };
    if (i >= n) return { x: 2 * fitPts[n - 1].x - fitPts[n - 2].x, y: 2 * fitPts[n - 1].y - fitPts[n - 2].y };
    return fitPts[i];
  }

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

    const spanStart: Pt = { x: pp1.x, y: pp1.y };
    const spanEnd: Pt = { x: pp2.x, y: pp2.y };
    pts.push(spanStart);

    const tMid = 0.5;
    const ptMid = catmullRomAt(pp0.x, pp0.y, pp1.x, pp1.y, pp2.x, pp2.y, pp3.x, pp3.y, tMid);
    if (chordHeight(spanStart.x, spanStart.y, ptMid.x, ptMid.y, spanEnd.x, spanEnd.y) > chordTol(spanStart.x, spanStart.y, spanEnd.x, spanEnd.y)) {
      subdivideSpan(s, 0, spanStart, tMid, ptMid, 1, pts);
      pts.push(ptMid);
      subdivideSpan(s, tMid, ptMid, 1, spanEnd, 1, pts);
    }
  }

  pts.push(closed
    ? { x: fitPts[0].x, y: fitPts[0].y }
    : { x: fitPts[n - 1].x, y: fitPts[n - 1].y });

  return pts;
}

/**
 * Approximates an ellipse or elliptical arc as an mm-space point list.
 * startRad/endRad are parametric angles (radians).
 */
export function ellipsePointsMm(
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

  // Determine if this is a full ellipse
  let isFull = false;
  const rawDiff = Math.abs(endRad - startRad);
  if (Math.abs(rawDiff - 2 * Math.PI) < 1e-6) {
    isFull = true;
  } else if (Math.abs(startRad) < 1e-9 && (Math.abs(endRad) < 1e-9 || Math.abs(endRad - 2 * Math.PI) < 1e-6)) {
    // start=0 and end=0 (AutoCAD full ellipse convention) or end=2*PI
    isFull = true;
  }

  let start = startRad;
  let end = isFull ? start + 2 * Math.PI : endRad;
  if (!isFull) {
    while (end <= start) end += 2 * Math.PI;
  }
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
