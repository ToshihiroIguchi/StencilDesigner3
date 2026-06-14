import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LibreDwg, Dwg_File_Type, type LibreDwgEx, type DwgDatabase } from '@mlightcad/libredwg-web';
import { convertDwgDatabase } from '../../src/dwg/importer';
import { insertMatrix, apply } from '../../src/dwg/blocks';
import type { ImportResult } from '../../src/dxf/importer';
import type { Polygon } from '../../src/types';
import type { DwgInsertEntity } from '@mlightcad/libredwg-web';

// Note: these tests run under Node, so the browser-only getLibreDwg() (no-arg
// create()) cannot be used — it fails on emscripten's data:URL fallback. Here we
// create LibreDwg with an explicit wasm directory and verify the pure
// convertDwgDatabase function.
const WASM_DIR = path.resolve('node_modules/@mlightcad/libredwg-web/wasm');
const FIXTURE_DIR = path.resolve('test/fixtures/dwg');

let lib: LibreDwgEx;

beforeAll(async () => {
  lib = await LibreDwg.create(WASM_DIR);
});

/** Reads a fixture and converts it into a DwgDatabase (dwg_free is already called). */
function loadDb(file: string): DwgDatabase {
  const buf = readFileSync(path.join(FIXTURE_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dwg = lib.dwg_read_data(ab, Dwg_File_Type.DWG);
  try {
    return lib.convert(dwg);
  } finally {
    lib.dwg_free(dwg);
  }
}

function loadResult(file: string): { db: DwgDatabase; result: ImportResult } {
  const db = loadDb(file);
  return { db, result: convertDwgDatabase(db) };
}

/** Confirms every polygon vertex (outer + holes) is an integer in µm. */
function allVerticesAreIntegers(polygons: Polygon[]): boolean {
  for (const p of polygons) {
    for (const ring of [p.outer, ...p.holes]) {
      for (const v of ring) {
        if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) return false;
      }
    }
  }
  return true;
}

const VERSION_FIXTURES = [
  'example_r14.dwg',
  'example_2000.dwg',
  'example_2007.dwg',
  'example_2013.dwg',
  'example_2018.dwg',
];

describe('convertDwgDatabase: version coverage', () => {
  for (const file of VERSION_FIXTURES) {
    it(`${file} imports without being empty`, () => {
      const { db, result } = loadResult(file);
      // Entities were read (guards against empty-import regressions)
      expect(db.entities.length).toBeGreaterThan(0);
      // Some geometry (closed polygons) was produced
      expect(result.polygons.length).toBeGreaterThan(0);
      // All coordinates are integer µm (the Y-flip and µm rounding are in effect)
      expect(allVerticesAreIntegers(result.polygons)).toBe(true);
      // A layer table was built
      expect(result.layers.length).toBeGreaterThan(0);
    });
  }
});

describe('convertDwgDatabase: INSERT / block expansion', () => {
  it('Dynblocks.dwg produces geometry after block expansion', () => {
    const { db, result } = loadResult('Dynblocks.dwg');
    expect(db.entities.length).toBeGreaterThan(0);
    // Assumes at least one non-anonymous block definition exists
    const blockNames = db.tables.BLOCK_RECORD.entries.map((b) => b.name);
    expect(blockNames.some((n) => !n.startsWith('*'))).toBe(true);
    // Expanded geometry is produced
    expect(result.polygons.length).toBeGreaterThan(0);
    expect(allVerticesAreIntegers(result.polygons)).toBe(true);
  });
});

describe('convertDwgDatabase: angle units (ARC is radians → degrees)', () => {
  it('a half-arc (0..π rad) plus a chord forms a half-circle polygon with the right bbox', () => {
    // Center (0,0), radius 1000mm, 0..π rad (= 0..180deg). The arc runs along the
    // top (Y-up) and is closed by the chord (1000,0)-(-1000,0).
    // With correct rad→deg conversion, internal µm (Y-flipped) gives
    //   x: [-1,000,000 .. 1,000,000], y: [-1,000,000 .. 0] — a half-circle.
    // If radians were mistaken for degrees, the arc would be a ~3deg sliver and the bbox would collapse.
    const fakeDb = {
      tables: { BLOCK_RECORD: { entries: [] }, LAYER: { entries: [] } },
      entities: [
        {
          type: 'ARC', layer: '0', handle: '1', ownerBlockRecordSoftId: '0', transparencyType: 0,
          center: { x: 0, y: 0, z: 0 }, radius: 1000,
          startAngle: 0, endAngle: Math.PI,
        },
        {
          type: 'LINE', layer: '0', handle: '2', ownerBlockRecordSoftId: '0', transparencyType: 0,
          startPoint: { x: -1000, y: 0, z: 0 }, endPoint: { x: 1000, y: 0, z: 0 },
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as DwgDatabase;

    const result = convertDwgDatabase(fakeDb);
    expect(result.ignoredCounts['_error'] ?? 0).toBe(0);
    expect(result.polygons.length).toBe(1);

    const ring = result.polygons[0].outer;
    const xs = ring.map((v) => v.x);
    const ys = ring.map((v) => v.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    // Half-circle: width ~2,000,000µm, height ~1,000,000µm (y goes negative after the Y-flip)
    expect(maxX - minX).toBeGreaterThan(1_900_000);
    expect(minX).toBeLessThan(-900_000);
    expect(maxX).toBeGreaterThan(900_000);
    expect(minY).toBeLessThan(-900_000); // top half lands below after the Y-flip
    expect(Math.abs(maxY)).toBeLessThan(50_000); // the chord sits at y≈0
  });

  it('insertMatrix: composes insertion point, rotation, scale, and basePoint correctly', () => {
    // Subtract basePoint(10,0) → rotate 90deg → translate to insertion point(100,200).
    const ins = {
      insertionPoint: { x: 100, y: 200, z: 0 },
      xScale: 1, yScale: 1, rotation: Math.PI / 2,
    } as DwgInsertEntity;
    const m = insertMatrix(ins, { x: 10, y: 0, z: 0 });
    // basePoint itself (10,0) maps to the insertion point.
    const a = apply(m, 10, 0);
    expect(a.x).toBeCloseTo(100, 6);
    expect(a.y).toBeCloseTo(200, 6);
    // A point 5 along +x from basePoint (15,0) rotates 90deg to +y → (100, 205).
    const b = apply(m, 15, 0);
    expect(b.x).toBeCloseTo(100, 6);
    expect(b.y).toBeCloseTo(205, 6);
  });

  it('INSERT expansion: a closed polygon inside a block appears at the insertion position', () => {
    // Block B: a 1000mm square (closed LWPOLYLINE) at the origin, placed at (5000,3000).
    const square = [
      { x: 0, y: 0, bulge: 0, id: 0 },
      { x: 1000, y: 0, bulge: 0, id: 1 },
      { x: 1000, y: 1000, bulge: 0, id: 2 },
      { x: 0, y: 1000, bulge: 0, id: 3 },
    ];
    const fakeDb = {
      tables: {
        BLOCK_RECORD: {
          entries: [
            {
              name: 'B', basePoint: { x: 0, y: 0, z: 0 },
              entities: [
                {
                  type: 'LWPOLYLINE', layer: '0', handle: '10', ownerBlockRecordSoftId: '0',
                  transparencyType: 0, flag: 1, elevation: 0, vertices: square,
                },
              ],
            },
          ],
        },
        LAYER: { entries: [] },
      },
      entities: [
        {
          type: 'INSERT', layer: '0', handle: '20', ownerBlockRecordSoftId: '0', transparencyType: 0,
          name: 'B', insertionPoint: { x: 5000, y: 3000, z: 0 },
          xScale: 1, yScale: 1, zScale: 1, rotation: 0,
          columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as DwgDatabase;

    const result = convertDwgDatabase(fakeDb);
    expect(result.ignoredCounts['_error'] ?? 0).toBe(0);
    expect(result.polygons.length).toBe(1);

    const ring = result.polygons[0].outer;
    const xs = ring.map((v) => v.x);
    const ys = ring.map((v) => v.y);
    // Insertion moves x:5000..6000mm → 5,000,000..6,000,000µm
    expect(Math.min(...xs)).toBe(5_000_000);
    expect(Math.max(...xs)).toBe(6_000_000);
    // y:3000..4000mm becomes -4,000,000..-3,000,000µm after the Y-flip
    expect(Math.min(...ys)).toBe(-4_000_000);
    expect(Math.max(...ys)).toBe(-3_000_000);
  });
});
