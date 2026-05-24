import { describe, it, expect } from 'vitest';
import { importDxf } from '../../src/dxf/importer';

// Minimal DXF wrapper — AC1015, no layers table needed for these tests
function wrapEntities(entities: string): string {
  return [
    '0\nSECTION\n2\nHEADER',
    '9\n$ACADVER\n1\nAC1015',
    '0\nENDSEC',
    '0\nSECTION\n2\nENTITIES',
    entities,
    '0\nENDSEC',
    '0\nEOF',
  ].join('\n');
}

// ---- helpers ----------------------------------------------------------------

/** Minimal closed LWPOLYLINE with optional per-vertex bulge values. */
function lwpoly(
  verts: Array<{ x: number; y: number; bulge?: number }>,
  layer = '0'
): string {
  const lines: string[] = [
    '0\nLWPOLYLINE',
    `8\n${layer}`,
    '70\n1',           // closed
    `90\n${verts.length}`,
  ];
  for (const v of verts) {
    lines.push(`10\n${v.x}`);
    lines.push(`20\n${v.y}`);
    if (v.bulge !== undefined && v.bulge !== 0) {
      lines.push(`42\n${v.bulge}`);
    }
  }
  return lines.join('\n');
}

/** CIRCLE entity. */
function circle(cx: number, cy: number, r: number, layer = '0'): string {
  return [
    '0\nCIRCLE',
    `8\n${layer}`,
    `10\n${cx}`,
    `20\n${cy}`,
    `40\n${r}`,
  ].join('\n');
}

/** Four LINE entities forming a closed rectangle (chained by chainSegments). */
function lineRect(
  x1: number, y1: number, x2: number, y2: number, layer = '0'
): string {
  const segs: Array<[number, number, number, number]> = [
    [x1, y1, x2, y1],
    [x2, y1, x2, y2],
    [x2, y2, x1, y2],
    [x1, y2, x1, y1],
  ];
  return segs.map(([ax, ay, bx, by]) => [
    '0\nLINE',
    `8\n${layer}`,
    `10\n${ax}`, `20\n${ay}`, `30\n0`,
    `11\n${bx}`, `21\n${by}`, `31\n0`,
  ].join('\n')).join('\n');
}

// =============================================================================

describe('importDxf — bulge (arc segments)', () => {
  it('bulge=0 rectangle: 4 vertices, right angles', async () => {
    // 10mm × 5mm rectangle, no bulge → 4 vertices expected after normalize
    const dxf = wrapEntities(lwpoly([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 },
    ]));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(1);
    expect(polygons[0].outer).toHaveLength(4);
  });

  it('semicircle (bulge=1): generates more than 2 arc vertices between endpoints', async () => {
    // Two-point LWPOLYLINE: (0,0)→(10,0) with bulge=1 (180° arc) + closing segment back
    // The arc from (0,0) to (10,0) with bulge=1 is a semicircle above the chord
    const dxf = wrapEntities(lwpoly([
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0 },
    ]));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(1);
    // A semicircle of r=5mm should have many interpolated vertices (≥16)
    expect(polygons[0].outer.length).toBeGreaterThan(8);
  });

  it('full circle via bulge (two-point LWPOLYLINE, bulge=1 twice): produces circular ring', async () => {
    // (0,0)→(10,0) bulge=1, then (10,0)→(0,0) bulge=1 → full circle
    const dxf = wrapEntities(lwpoly([
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0, bulge: 1 },
    ]));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(1);
    expect(polygons[0].outer.length).toBeGreaterThan(16);
  });

  it('CW arc (bulge=-1): produces arc vertices in opposite direction', async () => {
    const ccwDxf = wrapEntities(lwpoly([{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }]));
    const cwDxf  = wrapEntities(lwpoly([{ x: 0, y: 0, bulge: -1 }, { x: 10, y: 0 }]));
    const [ccw, cw] = await Promise.all([importDxf(ccwDxf), importDxf(cwDxf)]);
    // Both should produce a valid polygon
    expect(ccw.polygons).toHaveLength(1);
    expect(cw.polygons).toHaveLength(1);
    // The arc bows in opposite Y directions — centroids differ
    const centroidY = (poly: typeof ccw.polygons[0]) =>
      poly.outer.reduce((s, v) => s + v.y, 0) / poly.outer.length;
    expect(centroidY(ccw.polygons[0])).not.toBeCloseTo(centroidY(cw.polygons[0]), 0);
  });
});

// =============================================================================

describe('importDxf — outer/hole classification', () => {
  it('two concentric circles → 1 polygon with 1 hole', async () => {
    // outer r=10mm, inner r=5mm — same layer
    const dxf = wrapEntities([circle(0, 0, 10), circle(0, 0, 5)].join('\n'));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(1);
    expect(polygons[0].holes).toHaveLength(1);
    // Outer should have more vertices (larger circle)
    expect(polygons[0].outer.length).toBeGreaterThan(polygons[0].holes[0].length);
  });

  it('two separate circles → 2 independent polygons (no holes)', async () => {
    // Far apart — no containment
    const dxf = wrapEntities([circle(0, 0, 5), circle(100, 0, 5)].join('\n'));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(2);
    expect(polygons[0].holes).toHaveLength(0);
    expect(polygons[1].holes).toHaveLength(0);
  });

  it('different layers: outer on layer A, inner on layer B → 2 separate polygons', async () => {
    // Cross-layer containment should NOT produce a hole
    const dxf = wrapEntities([circle(0, 0, 10, 'A'), circle(0, 0, 5, 'B')].join('\n'));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(2);
    expect(polygons.every((p) => p.holes.length === 0)).toBe(true);
  });

  it('500 scattered circles → 500 independent polygons, no holes', async () => {
    // Performance check: 500 non-overlapping circles, 20mm spacing
    const entities: string[] = [];
    for (let i = 0; i < 500; i++) {
      const x = (i % 25) * 20;
      const y = Math.floor(i / 25) * 20;
      entities.push(circle(x, y, 1));
    }
    const dxf = wrapEntities(entities.join('\n'));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(500);
    expect(polygons.every((p) => p.holes.length === 0)).toBe(true);
  }, 5000); // 5s timeout — verify bbox pre-filter keeps this fast

  it('donut + outer frame → frame polygon with inner donut, donut has its own hole', async () => {
    // frame r=50, donut outer r=10, inner island r=5 — all same layer
    // depth 0 (r=50): outer → polygon
    // depth 1 (r=10): hole of r=50
    // depth 2 (r=5):  even → outer island (inside the hole), no holes of its own
    const dxf = wrapEntities([
      circle(0, 0, 50),
      circle(0, 0, 10),
      circle(0, 0, 5),
    ].join('\n'));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(2);
    const sorted = [...polygons].sort((a, b) => b.outer.length - a.outer.length);
    expect(sorted[0].holes).toHaveLength(1); // frame (r=50) with one hole (r=10)
    expect(sorted[1].holes).toHaveLength(0); // inner island (r=5) has no holes
  });
});

// =============================================================================

describe('importDxf — chainSegments (LINE entities)', () => {
  it('4 LINE segments forming a rectangle → 1 closed polygon', async () => {
    const dxf = wrapEntities(lineRect(0, 0, 10, 5));
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(1);
    expect(polygons[0].outer.length).toBeGreaterThanOrEqual(3);
  });

  it('open LINE chain (3 segments, not closed) → no polygon generated', async () => {
    const lines = [
      '0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n10\n21\n0\n31\n0',
      '0\nLINE\n8\n0\n10\n10\n20\n0\n30\n0\n11\n10\n21\n5\n31\n0',
      '0\nLINE\n8\n0\n10\n10\n20\n5\n30\n0\n11\n5\n21\n5\n31\n0',
    ].join('\n');
    const dxf = wrapEntities(lines);
    const { polygons } = await importDxf(dxf);
    expect(polygons).toHaveLength(0);
  });
});

// =============================================================================

describe('importDxf — ignoredCounts', () => {
  it('unsupported entities are counted, not thrown', async () => {
    const spline = '0\nSPLINE\n8\n0\n70\n8\n71\n3\n72\n0\n73\n0\n74\n0\n40\n0.0';
    const dxf = wrapEntities(spline);
    const { ignoredCounts } = await importDxf(dxf);
    expect(ignoredCounts['SPLINE']).toBe(1);
  });
});
