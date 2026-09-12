import type { Polygon, Ring, Layer, Vertex } from '../types';
import { newId } from '../types';
import { normalizeAllWithStats, bbox, pointInRing, hasSelfIntersection } from '../normalize';
import { dist } from '../core/geometry';
import { vertex } from '../core/vertex';
import { aciToHex } from './aci';
import {
  mmToUm,
  arcPointsMm,
  bulgeArcMm,
  expandVertsMm,
  bsplinePointsMm,
  fitSplinePointsMm,
  ellipsePointsMm,
  type Pt,
} from '../core/curve-approx';
import { type Mat, identity, multiply, apply } from '../dwg/blocks';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as ClipperLib from 'clipper-lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DxfEntity = any;

export interface ImportResult {
  polygons: Polygon[];
  layers: Layer[];
  ignoredCounts: Record<string, number>;
  unitName?: string;
  scale?: number;
}

export { mmToUm };

/**
 * Resolves the scaling factor to convert DXF/DWG file coordinates to integer µm.
 * Based on the AutoCAD $INSUNITS header variable.
 */
export function resolveUnitScale(insunits: number | undefined): { scale: number; unitName: string } {
  switch (insunits) {
    case 1:  return { scale: 25400, unitName: 'in' };
    case 2:  return { scale: 304800, unitName: 'ft' };
    case 4:  return { scale: 1000, unitName: 'mm' };
    case 5:  return { scale: 10000, unitName: 'cm' };
    case 6:  return { scale: 1000000, unitName: 'm' };
    case 8:  return { scale: 0.0254, unitName: 'µin' };
    case 9:  return { scale: 25.4, unitName: 'mil' };
    case 13: return { scale: 1, unitName: 'µm' };
    case 14: return { scale: 100000, unitName: 'dm' };
    default: return { scale: 1000, unitName: 'mm' }; // Screen printing default is mm
  }
}

/** Approximate arc as polyline segments. Returns vertices with new IDs. */
export function arcToPoints(cx: number, cy: number, r: number, startAngle: number, endAngle: number, ccw = true, scale = 1000): Vertex[] {
  const pts = arcPointsMm(cx, cy, r, startAngle, endAngle, ccw);
  return pts.map((p) => vertex(Math.round(p.x * scale), Math.round(-p.y * scale)));
}

/**
 * Convert a DXF LWPOLYLINE bulge segment to arc vertices.
 * Inputs are in DXF mm space (Y-up). arcToPoints handles the Y-flip.
 * Returns vertices from p1 toward p2 (inclusive of both endpoints).
 */
export function bulgeToArcPoints(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  bulge: number,
  scale = 1000
): Vertex[] {
  const pts = bulgeArcMm(p1x, p1y, p2x, p2y, bulge);
  return pts.map((p) => vertex(Math.round(p.x * scale), Math.round(-p.y * scale)));
}

/**
 * Expand a LWPOLYLINE/POLYLINE vertex list, handling bulge (arc) segments.
 * dxfVerts: [{x, y, bulge?}] in DXF mm space.
 * isClosed: whether the last vertex connects back to the first.
 * Returns vertices in screen µm space (Y-flipped).
 */
export function expandPolylineVerts(
  dxfVerts: Array<{ x: number; y: number; bulge?: number }>,
  isClosed: boolean,
  scale = 1000
): Vertex[] {
  const pts = expandVertsMm(dxfVerts, isClosed);
  return pts.map((p) => vertex(Math.round(p.x * scale), Math.round(-p.y * scale)));
}

/**
 * Applies matrix transform to mm-space points, applies scale, and converts to screen µm (Y-flipped).
 */
function toScreenVertices(m: Mat, pts: Pt[], scale: number): Vertex[] {
  return pts.map((pt) => {
    const p = apply(m, pt.x, pt.y);
    return vertex(Math.round(p.x * scale), Math.round(-p.y * scale));
  });
}

/**
 * Builds the affine transform matrix for a DXF INSERT entity.
 * DXF rotation is in degrees.
 */
export function dxfInsertMatrix(
  ins: { position?: { x: number; y: number }; xScale?: number; yScale?: number; rotation?: number },
  basePoint?: { x: number; y: number }
): Mat {
  const sx = ins.xScale ?? 1;
  const sy = ins.yScale ?? 1;
  const rot = (ins.rotation ?? 0) * (Math.PI / 180);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const ip = ins.position ?? { x: 0, y: 0 };
  const bp = basePoint ?? { x: 0, y: 0 };

  const rs: Mat = {
    a: cos * sx, b: sin * sx,
    c: -sin * sy, d: cos * sy,
    e: ip.x, f: ip.y,
  };
  const tNegBase: Mat = { a: 1, b: 0, c: 0, d: 1, e: -bp.x, f: -bp.y };
  return multiply(rs, tNegBase);
}

export interface PlacedDxfEntity {
  entity: any;
  matrix: Mat;
}

/**
 * Recursively flattens DXF entities by expanding INSERT (block references).
 * Entities defined on layer "0" inherit the layer of their parent INSERT block.
 */
export function flattenDxfEntities(
  entities: any[],
  blockMap: Record<string, { position?: { x: number; y: number }; entities?: any[] }>
): PlacedDxfEntity[] {
  const out: PlacedDxfEntity[] = [];

  function recurse(ents: any[], matrix: Mat, visited: Set<string>, depth: number, parentLayer?: string): void {
    if (depth > 16) return;
    for (const ent of ents) {
      const effectiveLayer = (ent.layer === '0' || !ent.layer) && parentLayer ? parentLayer : (ent.layer ?? '0');
      const resolvedEnt = ent.layer !== effectiveLayer ? { ...ent, layer: effectiveLayer } : ent;

      if (ent.type === 'INSERT') {
        const block = blockMap[ent.name];
        if (!block) continue;
        if (visited.has(ent.name)) continue;
        const cols = Math.max(1, ent.columnCount ?? 1);
        const rows = Math.max(1, ent.rowCount ?? 1);
        const colSp = ent.columnSpacing ?? 0;
        const rowSp = ent.rowSpacing ?? 0;
        const rot = (ent.rotation ?? 0) * (Math.PI / 180);
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const baseM = dxfInsertMatrix(ent, block.position);
        const nextVisited = new Set(visited);
        nextVisited.add(ent.name);
        const insLayer = effectiveLayer;

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const lx = c * colSp;
            const ly = r * rowSp;
            const dx = lx * cos - ly * sin;
            const dy = lx * sin + ly * cos;
            const offset: Mat = { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
            const cellM = multiply(offset, baseM);
            recurse(block.entities ?? [], multiply(matrix, cellM), nextVisited, depth + 1, insLayer);
          }
        }
      } else {
        out.push({ entity: resolvedEnt, matrix });
      }
    }
  }

  recurse(entities, identity(), new Set<string>(), 0);
  return out;
}

/**
 * Repairs a self-intersecting ring using Clipper.SimplifyPolygon.
 * Splits complex self-intersecting loops (e.g. figure-8) into sound simple rings.
 */
export function repairSelfIntersectingRing(ring: Ring): Ring[] {
  if (ring.length < 4 || !hasSelfIntersection(ring)) return [ring];

  const SCALE = 100;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = ClipperLib as any;
  const path = ring.map((p) => ({ X: p.x * SCALE, Y: p.y * SCALE }));
  const simplified = C.Clipper.SimplifyPolygon(path, C.PolyFillType.pftEvenOdd);
  if (!simplified || simplified.length === 0) return [ring];

  const result: Ring[] = [];
  for (const p of simplified) {
    if (p.length < 3) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: Ring = p.map((pt: any) => vertex(Math.round(pt.X / SCALE), Math.round(pt.Y / SCALE)));
    result.push(r);
  }
  return result.length > 0 ? result : [ring];
}

/**
 * Chain open segments into closed rings using a spatial endpoint hash.
 * Average O(n) with SNAP µm grid tolerance.
 */
/**
 * Chain open segments into closed rings using a spatial endpoint hash.
 * Also returns open chains that could not be closed.
 */
function chainSegments(segments: [Vertex, Vertex][]): { rings: Ring[]; openChains: Vertex[][] } {
  if (segments.length === 0) return { rings: [], openChains: [] };

  const SNAP = 10; // µm gap tolerance for chaining
  const CELL = SNAP; // grid cell size matches snap tolerance

  // Map from grid-key to list of {segIdx, whichEnd: 0=a, 1=b}
  const endMap = new Map<string, Array<{ idx: number; end: 0 | 1 }>>();

  function cellKey(x: number, y: number): string {
    return `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
  }

  function register(idx: number, end: 0 | 1, x: number, y: number): void {
    const key = cellKey(x, y);
    if (!endMap.has(key)) endMap.set(key, []);
    endMap.get(key)!.push({ idx, end });
  }

  function unregister(idx: number, end: 0 | 1, x: number, y: number): void {
    const key = cellKey(x, y);
    const list = endMap.get(key);
    if (!list) return;
    const pos = list.findIndex((e) => e.idx === idx && e.end === end);
    if (pos >= 0) list.splice(pos, 1);
  }

  function findNeighbour(x: number, y: number, excludeIdx: number): { idx: number; end: 0 | 1 } | null {
    const cx = Math.round(x / CELL);
    const cy = Math.round(y / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const list = endMap.get(key);
        if (!list) continue;
        for (const entry of list) {
          if (entry.idx === excludeIdx) continue;
          const [a, b] = segments[entry.idx];
          const ep = entry.end === 0 ? a : b;
          if (dist({ x, y } as Vertex, ep) <= SNAP) return entry;
        }
      }
    }
    return null;
  }

  // Build initial endpoint map
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    register(i, 0, a.x, a.y);
    register(i, 1, b.x, b.y);
  }

  const used = new Array(segments.length).fill(false);
  const rings: Ring[] = [];
  const openChains: Vertex[][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;

    const [a0, b0] = segments[start];
    const chain: Vertex[] = [a0, b0];
    used[start] = true;
    unregister(start, 0, a0.x, a0.y);
    unregister(start, 1, b0.x, b0.y);

    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      const nb = findNeighbour(tail.x, tail.y, -1);
      if (nb && !used[nb.idx]) {
        const [na, nb2] = segments[nb.idx];
        used[nb.idx] = true;
        unregister(nb.idx, 0, na.x, na.y);
        unregister(nb.idx, 1, nb2.x, nb2.y);
        chain.push(nb.end === 0 ? nb2 : na);
        extended = true;
      }
    }

    if (chain.length >= 3 && dist(chain[0], chain[chain.length - 1]) <= SNAP) {
      chain.pop(); // Remove closing duplicate
      // Repair self-intersection if present
      const repaired = repairSelfIntersectingRing(chain);
      rings.push(...repaired);
    } else if (chain.length >= 2) {
      openChains.push(chain);
    }
  }

  return { rings, openChains };
}

/**
 * Checks whether two rings are geometric duplicates (identical vertices).
 */
function ringsAreDuplicate(r1: Ring, r2: Ring): boolean {
  if (r1.length !== r2.length) return false;
  const n = r1.length;
  let matchForward = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(r1[i].x - r2[i].x) > 1 || Math.abs(r1[i].y - r2[i].y) > 1) {
      matchForward = false;
      break;
    }
  }
  if (matchForward) return true;
  let matchReverse = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(r1[i].x - r2[n - 1 - i].x) > 1 || Math.abs(r1[i].y - r2[n - 1 - i].y) > 1) {
      matchReverse = false;
      break;
    }
  }
  return matchReverse;
}

/**
 * Classify a flat list of rings into Polygons with correct outer/hole nesting.
 * Deduplicates identical rings to avoid hole-cancellation and repairs self-intersections.
 */
function classifyAndBuildPolygons(allRings: Array<{ ring: Ring; layer: string }>): Polygon[] {
  const valid = allRings.filter(({ ring }) => ring.length >= 3);
  if (valid.length === 0) return [];

  const polygons: Polygon[] = [];

  // Group by layer
  const byLayer = new Map<string, Ring[]>();
  for (const { ring, layer } of valid) {
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(ring);
  }

  for (const [layer, rawRings] of byLayer) {
    // Deduplicate identical rings to prevent duplicate CAD lines from cancelling outer rings
    const rings: Ring[] = [];
    for (const r of rawRings) {
      if (!rings.some((existing) => ringsAreDuplicate(existing, r))) {
        rings.push(r);
      }
    }

    const n = rings.length;
    if (n === 1) {
      polygons.push({ id: newId(), outer: rings[0], holes: [], layer });
      continue;
    }

    const bboxes = rings.map((r) => bbox(r));

    // Compute nesting depth: test if ring[i][0] lies inside rings[j]
    const depths = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const testPt = rings[i][0];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const bb = bboxes[j];
        if (testPt.x < bb.minX || testPt.x > bb.maxX ||
            testPt.y < bb.minY || testPt.y > bb.maxY) continue;
        if (pointInRing(testPt, rings[j])) depths[i]++;
      }
    }

    // Even depth = outer, odd depth = hole
    for (let oi = 0; oi < n; oi++) {
      if (depths[oi] % 2 !== 0) continue;

      const holes: Ring[] = [];
      for (let hi = 0; hi < n; hi++) {
        if (depths[hi] !== depths[oi] + 1) continue;
        if (pointInRing(rings[hi][0], rings[oi])) {
          holes.push(rings[hi]);
        }
      }
      polygons.push({ id: newId(), outer: rings[oi], holes, layer });
    }
  }

  return polygons;
}

function normalizeLinetype(lt: string | undefined): Layer['linetype'] {
  if (!lt) return 'CONTINUOUS';
  const upper = lt.toUpperCase();
  const valid = ['CONTINUOUS', 'DASHED', 'HIDDEN', 'CENTER', 'PHANTOM', 'DASHDOT'];
  return valid.includes(upper) ? upper as Layer['linetype'] : 'CONTINUOUS';
}

/**
 * Converts open line chains into thin rectangular polygons (stroked lines)
 * so that fiducials, centerlines, and slit cuts are preserved for screen-printing.
 */
function strokeOpenChains(chains: Vertex[][], widthUm: number, layer: string): Polygon[] {
  const half = Math.max(1, Math.round(widthUm / 2));
  const polys: Polygon[] = [];

  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const p1 = chain[i];
      const p2 = chain[i + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const ox = Math.round(nx * half);
      const oy = Math.round(ny * half);

      const outer: Ring = [
        vertex(p1.x + ox, p1.y + oy),
        vertex(p2.x + ox, p2.y + oy),
        vertex(p2.x - ox, p2.y - oy),
        vertex(p1.x - ox, p1.y - oy),
      ];
      polys.push({ id: newId(), outer, holes: [], layer });
    }
  }
  return polys;
}

export interface BuildImportOptions {
  strokeOpenPaths?: boolean;
  strokeWidthUm?: number;
  unitName?: string;
  scale?: number;
}

/**
 * Shared back-end stage that builds an ImportResult from segments, closed rings,
 * and layer info. Used by both DXF and DWG importers.
 */
export function buildImportResult(
  segments: Array<{ seg: [Vertex, Vertex]; layer: string }>,
  closedRings: Array<{ ring: Ring; layer: string }>,
  rawLayers: Array<Partial<Layer> & { name: string; colorIndex?: number; frozen?: boolean; lineType?: string; lineweight?: number; locked?: boolean; plot?: boolean }>,
  options: BuildImportOptions = {}
): ImportResult {
  const chainedRings: Array<{ ring: Ring; layer: string }> = [];
  const openChainsByLayer = new Map<string, Vertex[][]>();
  let totalOpenChains = 0;

  if (segments.length > 0) {
    const layerGroups = new Map<string, [Vertex, Vertex][]>();
    for (const { seg, layer } of segments) {
      if (!layerGroups.has(layer)) layerGroups.set(layer, []);
      layerGroups.get(layer)!.push(seg);
    }
    for (const [layer, segs] of layerGroups) {
      const { rings, openChains } = chainSegments(segs);
      for (const ring of rings) {
        chainedRings.push({ ring, layer });
      }
      if (openChains.length > 0) {
        openChainsByLayer.set(layer, openChains);
        totalOpenChains += openChains.length;
      }
    }
  }

  // Repair self-intersections in closed rings as well
  const repairedClosedRings: Array<{ ring: Ring; layer: string }> = [];
  for (const { ring, layer } of closedRings) {
    const repaired = repairSelfIntersectingRing(ring);
    for (const r of repaired) {
      repairedClosedRings.push({ ring: r, layer });
    }
  }

  const allRings = [...repairedClosedRings, ...chainedRings];
  const classifiedPolygons = classifyAndBuildPolygons(allRings);

  // Preserve open paths as stroked guide polygons only if explicitly requested
  const strokedPolygons: Polygon[] = [];
  if (options.strokeOpenPaths === true && totalOpenChains > 0) {
    const width = options.strokeWidthUm ?? 100; // 0.1 mm default stroke
    for (const [layer, chains] of openChainsByLayer) {
      strokedPolygons.push(...strokeOpenChains(chains, width, layer));
    }
  }

  const allPolygons = [...classifiedPolygons, ...strokedPolygons];

  // Build the layer table
  const importedLayers: Layer[] = rawLayers.map((rl) => {
    const colorIndex = Math.abs(rl.colorIndex ?? 7);
    const visible = (rl.colorIndex ?? 7) >= 0 && !rl.frozen;
    const name: string = rl.name;
    return {
      name,
      color: aciToHex(colorIndex),
      linetype: normalizeLinetype(rl.lineType),
      lineweight: rl.lineweight ?? -1,
      visible,
      locked: !!rl.locked,
      plot: rl.plot !== false,
      isAperture: name === 'REGMARK' || name.toUpperCase().includes('PASTE') || name.toUpperCase().includes('PAD'),
    };
  });

  const usedLayerNames = new Set(allPolygons.map((p) => p.layer));
  for (const name of usedLayerNames) {
    if (!importedLayers.some((l) => l.name === name)) {
      importedLayers.push({
        name, color: '#ffffff', linetype: 'CONTINUOUS', lineweight: -1,
        visible: true, locked: false, plot: true,
        isAperture: name === 'REGMARK' || name.toUpperCase().includes('PASTE') || name.toUpperCase().includes('PAD'),
      });
    }
  }

  const { polygons: normalized, droppedCount } = normalizeAllWithStats(allPolygons);
  const ignoredCounts: Record<string, number> = {};
  if (droppedCount > 0) {
    ignoredCounts['DROPPED_DEGENERATE'] = droppedCount;
  }
  if (totalOpenChains > 0 && !options.strokeOpenPaths) {
    ignoredCounts['OPEN_PATHS'] = totalOpenChains;
  }

  return {
    polygons: normalized,
    layers: importedLayers,
    ignoredCounts,
    unitName: options.unitName ?? 'mm',
    scale: options.scale ?? 1000,
  };
}

/** Parse DXF text and return polygons with layer information. */
export async function importDxf(dxfText: string, options: BuildImportOptions = {}): Promise<ImportResult> {
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

  // Resolve units from $INSUNITS header
  const insunits = typeof dxf?.header?.$INSUNITS === 'number' ? dxf.header.$INSUNITS : undefined;
  const { scale, unitName } = resolveUnitScale(insunits);

  const blockMap: Record<string, any> = dxf?.blocks ?? {};
  const rawEntities: DxfEntity[] = dxf?.entities ?? [];
  const placed = flattenDxfEntities(rawEntities, blockMap);

  const segments: Array<{ seg: [Vertex, Vertex]; layer: string }> = [];
  const closedRings: Array<{ ring: Ring; layer: string }> = [];
  const ignoredCounts: Record<string, number> = {};

  for (const { entity: ent, matrix } of placed) {
    const lyrName: string = ent.layer ?? '0';
    switch (ent.type) {
      case 'LINE': {
        const a = apply(matrix, ent.vertices[0].x, ent.vertices[0].y);
        const b = apply(matrix, ent.vertices[1].x, ent.vertices[1].y);
        const va = vertex(Math.round(a.x * scale), Math.round(-a.y * scale));
        const vb = vertex(Math.round(b.x * scale), Math.round(-b.y * scale));
        segments.push({ seg: [va, vb], layer: lyrName });
        break;
      }

      case 'ARC': {
        const pts = arcPointsMm(ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle, true);
        const verts = toScreenVertices(matrix, pts, scale);
        for (let i = 0; i < verts.length - 1; i++) {
          segments.push({ seg: [verts[i], verts[i + 1]], layer: lyrName });
        }
        break;
      }

      case 'CIRCLE': {
        const pts = arcPointsMm(ent.center.x, ent.center.y, ent.radius, 0, 360, true);
        const verts = toScreenVertices(matrix, pts.slice(0, -1), scale);
        closedRings.push({ ring: verts, layer: lyrName });
        break;
      }

      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const isClosed = !!(ent.shape || ent.closed);
        const pts = expandVertsMm(ent.vertices ?? [], isClosed);
        const verts = toScreenVertices(matrix, pts, scale);
        if (isClosed) {
          closedRings.push({ ring: verts, layer: lyrName });
        } else {
          for (let i = 0; i < verts.length - 1; i++) {
            segments.push({ seg: [verts[i], verts[i + 1]], layer: lyrName });
          }
        }
        break;
      }

      case 'ELLIPSE': {
        const isFull = Math.abs((ent.endAngle - ent.startAngle) - 2 * Math.PI) < 1e-6
          || (Math.abs(ent.startAngle) < 1e-9 && (Math.abs(ent.endAngle) < 1e-9 || Math.abs(ent.endAngle - 2 * Math.PI) < 1e-6));
        const pts = ellipsePointsMm(
          ent.center.x, ent.center.y,
          ent.majorAxisEndPoint.x, ent.majorAxisEndPoint.y,
          ent.axisRatio,
          ent.startAngle, isFull ? ent.startAngle + 2 * Math.PI : ent.endAngle,
        );
        if (isFull) {
          closedRings.push({ ring: toScreenVertices(matrix, pts.slice(0, -1), scale), layer: lyrName });
        } else {
          const verts = toScreenVertices(matrix, pts, scale);
          for (let i = 0; i < verts.length - 1; i++) {
            segments.push({ seg: [verts[i], verts[i + 1]], layer: lyrName });
          }
        }
        break;
      }

      case 'SPLINE': {
        const isClosed = !!ent.closed;
        let mmPts: Pt[] | null = null;
        if ((ent.controlPoints?.length ?? 0) >= 2 && ent.knotValues?.length === (ent.controlPoints.length + ent.degreeOfSplineCurve + 1)) {
          mmPts = bsplinePointsMm(ent.degreeOfSplineCurve, ent.controlPoints, ent.knotValues, undefined, isClosed);
        }
        if (mmPts === null && (ent.fitPoints?.length ?? 0) >= 2) {
          mmPts = fitSplinePointsMm(ent.fitPoints, isClosed);
        }
        if (mmPts === null) {
          const src = (ent.fitPoints?.length ?? 0) >= 2 ? ent.fitPoints : (ent.controlPoints ?? []);
          if (src.length >= 2) mmPts = src.map((p: any) => ({ x: p.x, y: p.y }));
        }
        if (mmPts && mmPts.length >= 2) {
          const verts = toScreenVertices(matrix, mmPts, scale);
          if (isClosed) {
            const ring = (verts.length > 1 && verts[0].x === verts[verts.length - 1].x && verts[0].y === verts[verts.length - 1].y)
              ? verts.slice(0, -1)
              : verts;
            closedRings.push({ ring, layer: lyrName });
          } else {
            for (let i = 0; i < verts.length - 1; i++) {
              segments.push({ seg: [verts[i], verts[i + 1]], layer: lyrName });
            }
          }
        } else {
          // Spline with insufficient points (< 2) is ignored
          ignoredCounts[ent.type] = (ignoredCounts[ent.type] ?? 0) + 1;
        }
        break;
      }

      default: {
        ignoredCounts[ent.type] = (ignoredCounts[ent.type] ?? 0) + 1;
        break;
      }
    }
  }

  // Convert the DXF LAYER table into the rawLayers shape expected by buildImportResult.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLayerMap: Record<string, any> = dxf?.tables?.layer?.layers ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLayers = Object.values(rawLayerMap).map((rl: any) => ({
    name: (rl.name ?? '0') as string,
    colorIndex: rl.colorIndex as number | undefined,
    frozen: rl.frozen as boolean | undefined,
    lineType: rl.lineType as string | undefined,
    lineweight: rl.lineweight as number | undefined,
    locked: rl.locked as boolean | undefined,
    plot: rl.plot as boolean | undefined,
  }));

  const result = buildImportResult(segments, closedRings, rawLayers, { ...options, unitName, scale });
  return { ...result, ignoredCounts: { ...result.ignoredCounts, ...ignoredCounts } };
}
