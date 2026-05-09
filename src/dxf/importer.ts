import type { Polygon, Ring, Point, Layer } from '../types';
import { newId } from '../types';
import { normalizeAll } from '../normalize';
import { dist } from '../core/geometry';

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

function aciToHex(aci: number): string {
  // AutoCAD Color Index → approximate CSS color (main colors only)
  const map: Record<number, string> = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff',
    5: '#0000ff', 6: '#ff00ff', 7: '#ffffff', 8: '#414141', 9: '#808080',
  };
  return map[aci] ?? '#ffffff';
}

function normalizeLinetype(lt: string | undefined): Layer['linetype'] {
  if (!lt) return 'CONTINUOUS';
  const upper = lt.toUpperCase();
  const valid = ['CONTINUOUS', 'DASHED', 'HIDDEN', 'CENTER', 'PHANTOM', 'DASHDOT'];
  return valid.includes(upper) ? upper as Layer['linetype'] : 'CONTINUOUS';
}

/** Parse DXF text and return polygons with layer information. */
export async function importDxf(dxfText: string): Promise<ImportResult> {
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
  // segments and closedRings track layer name per item
  const segments: Array<{ seg: [Point, Point]; layer: string }> = [];
  const closedRings: Array<{ ring: Ring; layer: string }> = [];
  const ignoredCounts: Record<string, number> = {};

  for (const ent of entities) {
    const lyrName: string = ent.layer ?? '0';
    switch (ent.type) {
      case 'LINE': {
        const a: Point = { x: mmToUm(ent.vertices[0].x), y: mmToUm(ent.vertices[0].y) };
        const b: Point = { x: mmToUm(ent.vertices[1].x), y: mmToUm(ent.vertices[1].y) };
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
        const ring: Ring = pts.slice(0, -1).map((p) => p);
        closedRings.push({ ring, layer: lyrName });
        break;
      }

      case 'LWPOLYLINE': {
        const pts: Point[] = ent.vertices.map((v: { x: number; y: number }) => ({
          x: mmToUm(v.x),
          y: mmToUm(v.y),
        }));
        if (ent.shape || ent.closed) {
          closedRings.push({ ring: pts, layer: lyrName });
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            segments.push({ seg: [pts[i], pts[i + 1]], layer: lyrName });
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

  // Chain open segments into rings, preserving layer (use first segment's layer)
  const chainedRings: Array<{ ring: Ring; layer: string }> = [];
  if (segments.length > 0) {
    // Group by layer for chaining
    const layerGroups = new Map<string, [Point, Point][]>();
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

  const polygons: Polygon[] = allRings
    .filter(({ ring }) => ring.length >= 3)
    .map(({ ring, layer }) => ({ id: newId(), outer: ring, holes: [], layer }));

  // Read LAYER table from DXF
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLayers: Record<string, any> = dxf?.tables?.layer?.layers ?? {};
  const importedLayers: Layer[] = Object.values(rawLayers).map((rl: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const colorIndex = Math.abs(rl.colorIndex ?? 7);
    const visible = (rl.colorIndex ?? 7) >= 0 && !rl.frozen;
    return {
      name: rl.name ?? '0',
      color: aciToHex(colorIndex),
      linetype: normalizeLinetype(rl.lineType),
      lineweight: rl.lineweight ?? -1,
      visible,
      locked: !!rl.locked,
      plot: rl.plot !== false,
      isAperture: false,
    };
  });

  // Supplement layer table with any layer names used by entities but not in the table
  const usedLayerNames = new Set(polygons.map((p) => p.layer));
  for (const name of usedLayerNames) {
    if (!importedLayers.some((l) => l.name === name)) {
      importedLayers.push({
        name, color: '#ffffff', linetype: 'CONTINUOUS', lineweight: -1,
        visible: true, locked: false, plot: true, isAperture: false,
      });
    }
  }

  return { polygons: normalizeAll(polygons), layers: importedLayers, ignoredCounts };
}
