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
          // Simple approximation: use fitPoints if present, otherwise treat controlPoints as a polyline.
          const src = (e.fitPoints && e.fitPoints.length >= 2) ? e.fitPoints : e.controlPoints;
          const mm: Pt[] = (src ?? []).map((p) => ({ x: p.x, y: p.y }));
          if (mm.length < 2) break;
          const isClosed = !!(e.flag & 1);
          const verts = toVertices(matrix, mm);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
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
