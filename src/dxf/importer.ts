import type { Polygon, Ring, Layer, Vertex } from '../types';
import { newId } from '../types';
import { normalizeAll, bbox, pointInRing } from '../normalize';
import { dist, getCircleSegments } from '../core/geometry';
import { vertex } from '../core/vertex';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DxfEntity = any;

export interface ImportResult {
  polygons: Polygon[];
  layers: Layer[];
  ignoredCounts: Record<string, number>;
}

/** Convert mm to µm (integer). */
function mmToUm(v: number): number {
  return Math.round(v * 1000);
}

/** Approximate arc as polyline segments. Returns vertices with new IDs. */
function arcToPoints(cx: number, cy: number, r: number, startAngle: number, endAngle: number, ccw = true): Vertex[] {
  const points: Vertex[] = [];
  let start = startAngle;
  let end = endAngle;
  if (ccw) {
    while (end < start) end += 360;   // span ∈ (0, 360]
  } else {
    while (end > start) end -= 360;   // span ∈ [-360, 0)
  }
  const span = end - start;
  const fullCircleSegments = getCircleSegments(mmToUm(r));
  const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * fullCircleSegments));
  for (let i = 0; i <= steps; i++) {
    const angle = ((start + (span * i) / steps) * Math.PI) / 180;
    points.push(vertex(mmToUm(cx + r * Math.cos(angle)), mmToUm(-(cy + r * Math.sin(angle)))));
  }
  return points;
}

/**
 * Convert a DXF LWPOLYLINE bulge segment to arc vertices.
 * Inputs are in DXF mm space (Y-up). arcToPoints handles the Y-flip.
 * Returns vertices from p1 toward p2 (inclusive of both endpoints).
 */
function bulgeToArcPoints(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  bulge: number
): Vertex[] {
  const dx = p2x - p1x;
  const dy = p2y - p1y;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord < 1e-9) return [vertex(mmToUm(p1x), mmToUm(-p1y))];

  // Left-perpendicular unit vector (in DXF Y-up space)
  const px = -dy / chord;
  const py = dx / chord;

  // Sagitta (signed: positive = arc bows to the left of p1→p2)
  const sagitta = bulge * chord / 2;
  const r = (chord * chord / 4 + sagitta * sagitta) / (2 * Math.abs(sagitta));

  // Center offset along left-perp: sign(bulge)*(r-|sagitta|).
  // For CCW (bulge>0, small arc): offset = +(r-s) > 0 → center to the left.
  // For CCW (bulge>0, large arc): offset = +(r-s) < 0 → center to the right (correct for >180°).
  // For CW  (bulge<0, small arc): offset = -(r-|s|) < 0 → center to the right.
  // For CW  (bulge<0, large arc): offset = -(r-|s|) > 0 → center to the left.
  const perpOffset = Math.sign(bulge) * (r - Math.abs(sagitta));
  const cx = (p1x + p2x) / 2 + px * perpOffset;
  const cy = (p1y + p2y) / 2 + py * perpOffset;

  const startAngle = Math.atan2(p1y - cy, p1x - cx) * (180 / Math.PI);
  const endAngle   = Math.atan2(p2y - cy, p2x - cx) * (180 / Math.PI);

  if (bulge > 0) {
    return arcToPoints(cx, cy, r, startAngle, endAngle, true);
  } else {
    return arcToPoints(cx, cy, r, startAngle, endAngle, false);
  }
}

/**
 * Expand a LWPOLYLINE/POLYLINE vertex list, handling bulge (arc) segments.
 * dxfVerts: [{x, y, bulge?}] in DXF mm space.
 * isClosed: whether the last vertex connects back to the first.
 * Returns vertices in screen µm space (Y-flipped).
 */
function expandPolylineVerts(
  dxfVerts: Array<{ x: number; y: number; bulge?: number }>,
  isClosed: boolean
): Vertex[] {
  const pts: Vertex[] = [];
  const n = dxfVerts.length;
  if (n === 0) return pts;

  // Number of segments to process (last vertex of open polyline has no outgoing segment)
  const segCount = isClosed ? n : n - 1;

  for (let i = 0; i < n; i++) {
    const v = dxfVerts[i];
    const bulge = v.bulge ?? 0;

    if (i >= segCount || Math.abs(bulge) < 1e-9) {
      // Straight segment or last vertex of open polyline — just add the point
      pts.push(vertex(mmToUm(v.x), mmToUm(-v.y)));
    } else {
      const nextV = dxfVerts[(i + 1) % n];
      const arcPts = bulgeToArcPoints(v.x, v.y, nextV.x, nextV.y, bulge);
      // Include all arc points except the last, which will be added by the next iteration
      pts.push(...arcPts.slice(0, -1));
    }
  }

  return pts;
}

/**
 * Chain open segments into closed rings using a spatial endpoint hash.
 * Average O(n) with SNAP µm grid tolerance.
 */
function chainSegments(segments: [Vertex, Vertex][]): Ring[] {
  if (segments.length === 0) return [];

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
    // Check 3×3 neighbourhood to handle points near cell boundaries
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
        // Append the far end of the found segment
        chain.push(nb.end === 0 ? nb2 : na);
        extended = true;
      }
    }

    if (chain.length >= 3 && dist(chain[0], chain[chain.length - 1]) <= SNAP) {
      chain.pop(); // Remove closing duplicate
      rings.push(chain);
    }
  }

  return rings;
}

/**
 * Classify a flat list of rings into Polygons with correct outer/hole nesting.
 * Uses bbox pre-filtering to avoid O(n²×m) pointInRing calls for dense data.
 * Grouping is per-layer; cross-layer containment is ignored.
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

  for (const [layer, rings] of byLayer) {
    const n = rings.length;

    if (n === 1) {
      polygons.push({ id: newId(), outer: rings[0], holes: [], layer });
      continue;
    }

    // Pre-compute bounding boxes once
    const bboxes = rings.map((r) => bbox(r));

    // Compute nesting depth: how many other rings contain rings[i][0]
    const depths = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const testPt = rings[i][0];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const bb = bboxes[j];
        // Cheap bbox pre-filter before expensive pointInRing
        if (testPt.x < bb.minX || testPt.x > bb.maxX ||
            testPt.y < bb.minY || testPt.y > bb.maxY) continue;
        if (pointInRing(testPt, rings[j])) depths[i]++;
      }
    }

    // Even depth = outer, odd depth = hole
    for (let oi = 0; oi < n; oi++) {
      if (depths[oi] % 2 !== 0) continue; // skip holes in this pass

      const holes: Ring[] = [];
      for (let hi = 0; hi < n; hi++) {
        if (depths[hi] !== depths[oi] + 1) continue;
        // Assign this hole to the nearest outer (direct parent only)
        if (pointInRing(rings[hi][0], rings[oi])) {
          holes.push(rings[hi]);
        }
      }
      polygons.push({ id: newId(), outer: rings[oi], holes, layer });
    }
  }

  return polygons;
}

function aciToHex(aci: number): string {
  // AutoCAD Color Index (ACI) — standard 255-color palette (indices 1–9 + 10–249 interpolated)
  const exact: Record<number, string> = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff',
    5: '#0000ff', 6: '#ff00ff', 7: '#ffffff', 8: '#414141', 9: '#808080',
  };
  if (exact[aci]) return exact[aci];
  // ACI 10–249: arranged in 24 hue groups of 10 shades each
  if (aci >= 10 && aci <= 249) {
    const hueIdx = Math.floor((aci - 10) / 10); // 0..23
    const shadeIdx = (aci - 10) % 10;           // 0..9
    const hue = (hueIdx / 24) * 360;
    // Shades 0,2,4,6,8 → full sat; 1,3,5,7,9 → half sat; lightness varies
    const lightness = 20 + shadeIdx * 6;
    const saturation = shadeIdx % 2 === 0 ? 100 : 50;
    return hslToHex(hue, saturation, lightness);
  }
  return '#ffffff';
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = ln - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function normalizeLinetype(lt: string | undefined): Layer['linetype'] {
  if (!lt) return 'CONTINUOUS';
  const upper = lt.toUpperCase();
  const valid = ['CONTINUOUS', 'DASHED', 'HIDDEN', 'CENTER', 'PHANTOM', 'DASHDOT'];
  return valid.includes(upper) ? upper as Layer['linetype'] : 'CONTINUOUS';
}

/** Parse DXF text and return polygons with layer information. */
export async function importDxf(dxfText: string): Promise<ImportResult> {
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
  const segments: Array<{ seg: [Vertex, Vertex]; layer: string }> = [];
  const closedRings: Array<{ ring: Ring; layer: string }> = [];
  const ignoredCounts: Record<string, number> = {};

  for (const ent of entities) {
    const lyrName: string = ent.layer ?? '0';
    switch (ent.type) {
      case 'LINE': {
        const a = vertex(mmToUm(ent.vertices[0].x), mmToUm(-ent.vertices[0].y));
        const b = vertex(mmToUm(ent.vertices[1].x), mmToUm(-ent.vertices[1].y));
        segments.push({ seg: [a, b], layer: lyrName });
        break;
      }

      case 'ARC': {
        const pts = arcToPoints(ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle);
        for (let i = 0; i < pts.length - 1; i++) {
          segments.push({ seg: [pts[i], pts[i + 1]], layer: lyrName });
        }
        break;
      }

      case 'CIRCLE': {
        const pts = arcToPoints(ent.center.x, ent.center.y, ent.radius, 0, 360);
        const ring: Ring = pts.slice(0, -1);
        closedRings.push({ ring, layer: lyrName });
        break;
      }

      case 'LWPOLYLINE': {
        const isClosed = !!(ent.shape || ent.closed);
        const pts = expandPolylineVerts(ent.vertices ?? [], isClosed);
        if (isClosed) {
          closedRings.push({ ring: pts, layer: lyrName });
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            segments.push({ seg: [pts[i], pts[i + 1]], layer: lyrName });
          }
        }
        break;
      }

      case 'POLYLINE': {
        const isClosed = !!(ent.shape || ent.closed);
        const pts = expandPolylineVerts(ent.vertices ?? [], isClosed);
        if (isClosed) {
          closedRings.push({ ring: pts, layer: lyrName });
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            segments.push({ seg: [pts[i], pts[i + 1]], layer: lyrName });
          }
        }
        break;
      }

      default: {
        ignoredCounts[ent.type] = (ignoredCounts[ent.type] ?? 0) + 1;
        break;
      }
    }
  }

  // Chain open segments into rings, preserving layer
  const chainedRings: Array<{ ring: Ring; layer: string }> = [];
  if (segments.length > 0) {
    const layerGroups = new Map<string, [Vertex, Vertex][]>();
    for (const { seg, layer } of segments) {
      if (!layerGroups.has(layer)) layerGroups.set(layer, []);
      layerGroups.get(layer)!.push(seg);
    }
    for (const [layer, segs] of layerGroups) {
      const rings = chainSegments(segs);
      for (const ring of rings) {
        chainedRings.push({ ring, layer });
      }
    }
  }

  const allRings = [...closedRings, ...chainedRings];

  // Classify rings into polygons with correct outer/hole nesting
  const polygons = classifyAndBuildPolygons(allRings);

  // Read LAYER table from DXF
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLayers: Record<string, any> = dxf?.tables?.layer?.layers ?? {};
  const importedLayers: Layer[] = Object.values(rawLayers).map((rl: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const colorIndex = Math.abs(rl.colorIndex ?? 7);
    const visible = (rl.colorIndex ?? 7) >= 0 && !rl.frozen;
    const name: string = rl.name ?? '0';
    return {
      name,
      color: aciToHex(colorIndex),
      linetype: normalizeLinetype(rl.lineType),
      lineweight: rl.lineweight ?? -1,
      visible,
      locked: !!rl.locked,
      plot: rl.plot !== false,
      isAperture: name === 'REGMARK',
    };
  });

  // Supplement layer table with any layer names used by entities but not in the table
  const usedLayerNames = new Set(polygons.map((p) => p.layer));
  for (const name of usedLayerNames) {
    if (!importedLayers.some((l) => l.name === name)) {
      importedLayers.push({
        name, color: '#ffffff', linetype: 'CONTINUOUS', lineweight: -1,
        visible: true, locked: false, plot: true, isAperture: name === 'REGMARK',
      });
    }
  }

  return { polygons: normalizeAll(polygons), layers: importedLayers, ignoredCounts };
}
