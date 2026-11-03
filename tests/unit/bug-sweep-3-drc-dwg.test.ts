import { describe, it, expect } from 'vitest';
import type { Polygon, Layer } from '../../src/types';
import type { DwgDatabase, DwgEntity, DwgBlockRecordTableEntry } from '@mlightcad/libredwg-web';
import { polygonEdgeDistance, polygonNarrowestPassage, polygonsOverlap } from '../../src/core/geometry';
import { runDrc } from '../../src/core/drc';
import { convertDwgDatabase } from '../../src/dwg/importer';
import { flattenEntities, buildBlockMap } from '../../src/dwg/blocks';

const layer0: Layer = {
  name: '0', color: '#4a9eff', linetype: 'CONTINUOUS', lineweight: -1,
  visible: true, locked: false, plot: true, isAperture: true,
};

function rect(x1: number, y1: number, x2: number, y2: number, id = 'r'): Polygon {
  return {
    id,
    outer: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
    holes: [],
    layer: '0',
  };
}

/** Square with a square hole (hole ring is CW). */
function framed(id: string, o: number, h1: number, h2: number): Polygon {
  const p = rect(0, 0, o, o, id);
  p.holes = [[{ x: h1, y: h1 }, { x: h1, y: h2 }, { x: h2, y: h2 }, { x: h2, y: h1 }]];
  return p;
}

describe('DRC with holes', () => {
  it('edge distance sees a shape sitting inside a hole', () => {
    const a = framed('a', 1000, 200, 800);
    const b = rect(210, 210, 790, 790, 'b');
    expect(polygonsOverlap(a, b)).toBe(false);
    expect(polygonEdgeDistance(a, b).dist).toBeCloseTo(10, 6);
  });

  it('spacing rule flags a shape 10um inside a hole, without an overlap report', () => {
    const a = framed('a', 1000, 200, 800);
    const b = rect(210, 210, 790, 790, 'b');
    const errs = runDrc([a, b], [layer0], { minApertureUm: 30, minSpacingUm: 30 });
    expect(errs.some((e) => e.message.startsWith('Spacing'))).toBe(true);
    expect(errs.some((e) => e.message === 'Shapes overlap')).toBe(false);
  });

  it('narrowest passage measures outer-vs-hole walls', () => {
    const p = framed('p', 1000, 5, 995);
    expect(polygonNarrowestPassage(p).width).toBeCloseTo(5, 6);
  });

  it('narrowest passage of a sliver triangle is its minimum altitude', () => {
    const tri: Polygon = {
      id: 't', layer: '0', holes: [],
      outer: [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 5000, y: 10 }],
    };
    expect(polygonNarrowestPassage(tri).width).toBeCloseTo(10, 1);
    const errs = runDrc([tri], [layer0], { minApertureUm: 30, minSpacingUm: 30 });
    expect(errs.some((e) => e.message.startsWith('Aperture'))).toBe(true);
  });

  it('aperture errors are capped but spacing checks still run', () => {
    const shapes: Polygon[] = [];
    for (let i = 0; i < 30; i++) shapes.push(rect(i * 10000, 0, i * 10000 + 1000, 5, `thin${i}`));
    shapes.push(rect(0, 100000, 500, 100500, 'n1'));
    shapes.push(rect(520, 100000, 1020, 100500, 'n2'));
    const errs = runDrc(shapes, [layer0], { minApertureUm: 30, minSpacingUm: 30 });
    const ap = errs.filter((e) => e.message.startsWith('Aperture'));
    expect(ap.length).toBe(10);
    expect(errs.some((e) => e.shapeId2 === 'n2')).toBe(true);
  });
});

// ---- DWG ----
function dbOf(entities: unknown[], blocks: unknown[] = []): DwgDatabase {
  return {
    header: { insunits: 4 },
    entities,
    tables: { BLOCK_RECORD: { entries: blocks }, LAYER: { entries: [] } },
  } as unknown as DwgDatabase;
}
const Z_DOWN = { x: 0, y: 0, z: -1 };
const Z_UP = { x: 0, y: 0, z: 1 };

function bbox(p: Polygon) {
  const xs = p.outer.map((v) => v.x), ys = p.outer.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function unionBbox(ps: Polygon[]) {
  const bs = ps.map(bbox);
  return {
    minX: Math.min(...bs.map((b) => b.minX)), maxX: Math.max(...bs.map((b) => b.maxX)),
    minY: Math.min(...bs.map((b) => b.minY)), maxY: Math.max(...bs.map((b) => b.maxY)),
  };
}

function lw(vertices: Array<{ x: number; y: number; bulge?: number }>, ext = Z_UP) {
  return {
    type: 'LWPOLYLINE', layer: 'L', flag: 1, extrusionDirection: ext,
    vertices: vertices.map((v) => ({ id: 0, bulge: 0, ...v })),
  };
}

describe('DWG import hardening', () => {
  it('drops non-finite points', () => {
    const r = convertDwgDatabase(dbOf([lw([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: NaN, y: 5 }])]));
    expect(r.polygons).toHaveLength(1);
    for (const v of r.polygons[0].outer) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
    }
    const r2 = convertDwgDatabase(dbOf([lw([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: Infinity, y: 5 }])]));
    expect(r2.polygons).toHaveLength(0);
  });

  it('cycle guard is case-insensitive', () => {
    const sq = { type: 'LWPOLYLINE', layer: '0', flag: 1, vertices: [] };
    const block = {
      name: 'A', basePoint: { x: 0, y: 0, z: 0 },
      entities: [sq, { type: 'INSERT', name: 'a', layer: '0', insertionPoint: { x: 0, y: 0, z: 0 } }],
    };
    const map = buildBlockMap([block as unknown as DwgBlockRecordTableEntry]);
    const placed = flattenEntities(
      [{ type: 'INSERT', name: 'A', layer: '0', insertionPoint: { x: 0, y: 0, z: 0 } } as unknown as DwgEntity],
      map,
    );
    expect(placed).toHaveLength(1);
  });

  it('LWPOLYLINE with extrusion z<0 mirrors x', () => {
    const r = convertDwgDatabase(dbOf([lw([{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }], Z_DOWN)]));
    const b = bbox(r.polygons[0]);
    expect(b.minX).toBe(-20000);
    expect(b.maxX).toBe(-10000);
  });

  it('LWPOLYLINE with extrusion z<0 keeps bulge side after mirroring', () => {
    const r = convertDwgDatabase(dbOf([
      lw([{ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], Z_DOWN),
    ]));
    const b = bbox(r.polygons[0]);
    // Bulge pushes the edge to mm y<0 (sagitta 2.5mm) = +2500um after the Y flip.
    expect(b.maxY).toBeGreaterThan(2400);
    expect(b.maxY).toBeLessThanOrEqual(2500);
    expect(b.minX).toBe(-10000);
  });

  it('CIRCLE with extrusion z<0 mirrors its center', () => {
    const r = convertDwgDatabase(dbOf([
      { type: 'CIRCLE', layer: 'L', center: { x: 10, y: 5, z: 0 }, radius: 2, extrusionDirection: Z_DOWN },
    ]));
    const b = bbox(r.polygons[0]);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(-10000, -1);
  });

  it('ARC with extrusion z<0 sweeps the mirrored quadrant', () => {
    const r = convertDwgDatabase(dbOf([
      { type: 'ARC', layer: 'L', center: { x: 0, y: 0, z: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, extrusionDirection: Z_DOWN },
    ]), { strokeOpenPaths: true, strokeWidthUm: 100 });
    expect(r.polygons.length).toBeGreaterThan(0);
    const b = unionBbox(r.polygons);
    // World quadrant: x in [-10,0] mm, y in [0,10] mm => um y in [-10000,0]
    expect(b.maxX).toBeLessThan(1000);
    expect(b.minX).toBeLessThan(-9000);
    expect(b.maxY).toBeLessThan(1000);
    expect(b.minY).toBeLessThan(-9000);
  });

  it('partial ELLIPSE with extrusion z<0 reverses the sweep', () => {
    const r = convertDwgDatabase(dbOf([
      {
        type: 'ELLIPSE', layer: 'L', center: { x: 0, y: 0, z: 0 }, majorAxisEndPoint: { x: 10, y: 0, z: 0 },
        axisRatio: 0.5, startAngle: 0, endAngle: Math.PI / 2, extrusionDirection: Z_DOWN,
      },
    ]), { strokeOpenPaths: true, strokeWidthUm: 100 });
    const b = unionBbox(r.polygons);
    // Minor axis points to -y (mm): arc spans y in [-5,0] mm => um y in [0,5000]
    expect(b.minY).toBeGreaterThan(-100);
    expect(b.maxY).toBeGreaterThan(4900);
  });

  it('INSERT with extrusion z<0 mirrors its placement', () => {
    const block = {
      name: 'B', basePoint: { x: 0, y: 0, z: 0 },
      entities: [{ type: 'LWPOLYLINE', layer: '0', flag: 1, vertices: [] }],
    };
    const map = buildBlockMap([block as unknown as DwgBlockRecordTableEntry]);
    const placed = flattenEntities(
      [{ type: 'INSERT', name: 'B', layer: '0', insertionPoint: { x: 10, y: 0, z: 0 }, extrusionDirection: Z_DOWN } as unknown as DwgEntity],
      map,
    );
    expect(placed).toHaveLength(1);
    const m = placed[0].matrix;
    expect(m.a * 1 + m.e).toBeCloseTo(-11, 9);
    expect(m.b * 1 + m.f).toBeCloseTo(0, 9);
  });
});
