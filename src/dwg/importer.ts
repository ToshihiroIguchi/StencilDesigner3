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
import { buildImportResult, resolveUnitScale, type ImportResult, type BuildImportOptions } from '../dxf/importer';
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
import {
  RAD2DEG,
  arcPointsMm,
  expandVertsMm,
  bsplinePointsMm,
  fitSplinePointsMm,
  ellipsePointsMm,
  type Pt,
} from '../core/curve-approx';

// Re-export for unit tests that import from this module
export { bsplinePointsMm, fitSplinePointsMm };

/** Applies the matrix to an mm-space point, then rounds to µm with scale and Y-flips into a Vertex. */
function toVertex(m: Mat, x: number, y: number, scale = 1000): Vertex {
  const p = apply(m, x, y);
  return vertex(Math.round(p.x * scale), Math.round(-p.y * scale));
}

/** Converts an mm-space point list to Vertices via matrix apply + scale µm/Y-flip. */
function toVertices(m: Mat, pts: Pt[], scale = 1000): Vertex[] {
  return pts.map((p) => toVertex(m, p.x, p.y, scale));
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
export function convertDwgDatabase(db: DwgDatabase, options: BuildImportOptions = {}): ImportResult {
  const segments: Array<{ seg: [Vertex, Vertex]; layer: string }> = [];
  const closedRings: Array<{ ring: Ring; layer: string }> = [];
  const ignoredCounts: Record<string, number> = {};

  // Resolve units from header if present, falling back to options or mm default
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawInsunits = (db.header as any)?.insunits ?? (db.header as any)?.$INSUNITS;
  const insunits = typeof rawInsunits === 'number' ? rawInsunits : undefined;
  const resolved = resolveUnitScale(insunits);
  const scale = options.scale ?? resolved.scale;
  const unitName = options.unitName ?? resolved.unitName;

  const blockMap = buildBlockMap(db.tables?.BLOCK_RECORD?.entries ?? []);
  const placed = flattenEntities(db.entities ?? [], blockMap);

  for (const { entity, matrix } of placed) {
    const layer = entity.layer ?? '0';
    try {
      switch (entity.type) {
        case 'LINE': {
          const e = entity as DwgLineEntity;
          const a = toVertex(matrix, e.startPoint.x, e.startPoint.y, scale);
          const b = toVertex(matrix, e.endPoint.x, e.endPoint.y, scale);
          segments.push({ seg: [a, b], layer });
          break;
        }
        case 'LWPOLYLINE': {
          const e = entity as DwgLWPolylineEntity;
          const isClosed = !!(e.flag & 1);
          const mm = expandVertsMm(e.vertices ?? [], isClosed);
          const verts = toVertices(matrix, mm, scale);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
          break;
        }
        case 'POLYLINE2D': {
          const e = entity as DwgPolyline2dEntity;
          const isClosed = !!(e.flag & 1);
          const mm = expandVertsMm(e.vertices ?? [], isClosed);
          const verts = toVertices(matrix, mm, scale);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
          break;
        }
        case 'POLYLINE3D': {
          const e = entity as DwgPolyline3dEntity;
          const isClosed = !!(e.flag & 1);
          const mm: Pt[] = (e.vertices ?? []).map((v) => ({ x: v.x, y: v.y }));
          const verts = toVertices(matrix, mm, scale);
          if (isClosed) closedRings.push({ ring: verts, layer });
          else pushSegments(verts, layer, segments);
          break;
        }
        case 'ARC': {
          const e = entity as DwgArcEntity;
          const mm = arcPointsMm(e.center.x, e.center.y, e.radius, e.startAngle * RAD2DEG, e.endAngle * RAD2DEG, true);
          pushSegments(toVertices(matrix, mm, scale), layer, segments);
          break;
        }
        case 'CIRCLE': {
          const e = entity as DwgCircleEntity;
          const mm = arcPointsMm(e.center.x, e.center.y, e.radius, 0, 360, true);
          const verts = toVertices(matrix, mm.slice(0, -1), scale);
          closedRings.push({ ring: verts, layer });
          break;
        }
        case 'ELLIPSE': {
          const e = entity as DwgEllipseEntity;
          const isFull = Math.abs((e.endAngle - e.startAngle) - 2 * Math.PI) < 1e-6
            || (Math.abs(e.startAngle) < 1e-9 && (Math.abs(e.endAngle) < 1e-9 || Math.abs(e.endAngle - 2 * Math.PI) < 1e-6));
          const mm = ellipsePointsMm(
            e.center.x, e.center.y,
            e.majorAxisEndPoint.x, e.majorAxisEndPoint.y,
            e.axisRatio,
            e.startAngle, isFull ? e.startAngle + 2 * Math.PI : e.endAngle,
          );
          if (isFull) {
            closedRings.push({ ring: toVertices(matrix, mm.slice(0, -1), scale), layer });
          } else {
            pushSegments(toVertices(matrix, mm, scale), layer, segments);
          }
          break;
        }
        case 'SPLINE': {
          const e = entity as DwgSplineEntity;
          const isClosed = !!(e.flag & 1);
          let mm: Pt[] | null = null;

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

          if (mm === null && (e.fitPoints?.length ?? 0) >= 2) {
            mm = fitSplinePointsMm(
              e.fitPoints.map((p) => ({ x: p.x, y: p.y })),
              isClosed,
            );
          }

          if (mm === null) {
            const src = (e.fitPoints?.length ?? 0) >= 2 ? e.fitPoints : (e.controlPoints ?? []);
            if (src.length < 2) break;
            mm = src.map((p) => ({ x: p.x, y: p.y }));
          }

          if (mm.length < 2) break;
          const verts = toVertices(matrix, mm, scale);
          if (isClosed) {
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
      ignoredCounts['_error'] = (ignoredCounts['_error'] ?? 0) + 1;
    }
  }

  const rawLayers = (db.tables?.LAYER?.entries ?? []).map((l) => ({
    name: l.name,
    colorIndex: l.off ? -Math.abs(l.colorIndex ?? 7) : (l.colorIndex ?? 7),
    frozen: !!l.frozen,
    lineType: l.lineType,
    lineweight: l.lineweight,
    locked: !!l.locked,
    plot: l.plotFlag !== 0,
  }));

  const result = buildImportResult(segments, closedRings, rawLayers, { ...options, unitName, scale });
  return { ...result, ignoredCounts: { ...result.ignoredCounts, ...ignoredCounts } };
}

/** Parses a DWG file (ArrayBuffer) and returns an ImportResult. */
export async function importDwg(buf: ArrayBuffer, options: BuildImportOptions = {}): Promise<ImportResult> {
  const lib = await getLibreDwg();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dwg: any;
  try {
    dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG);
    const db: DwgDatabase = lib.convert(dwg);
    return convertDwgDatabase(db, options);
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
