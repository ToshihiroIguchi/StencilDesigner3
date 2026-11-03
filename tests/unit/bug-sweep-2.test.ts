import { describe, it, expect } from 'vitest';
import type { Font } from 'opentype.js';
import { bsplinePointsMm } from '../../src/core/curve-approx';
import { textToPolygons } from '../../src/core/text-to-polygon';
import { cutPolygon } from '../../src/core/cut';
import { areEdgesParallel } from '../../src/core/centerline-geometry';
import { moveShapes, copyShapes, arrayCopyShapes } from '../../src/core/transform';
import { applyFillet, roundAllCorners } from '../../src/core/fillet';
import { rectToPolygon } from '../../src/core/geometry';
import { vertex } from '../../src/core/vertex';
import { normalize } from '../../src/normalize';
import { newId } from '../../src/types';
import type { Polygon, Ring } from '../../src/types';

function isInt(r: Ring): boolean {
  return r.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y));
}
function allInt(p: Polygon): boolean {
  return isInt(p.outer) && p.holes.every(isInt);
}
function area(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length;
    a += r[i].x * r[j].y - r[j].x * r[i].y;
  }
  return Math.abs(a / 2);
}
function polyArea(p: Polygon): number {
  return area(p.outer) - p.holes.reduce((s, h) => s + area(h), 0);
}

describe('curve flattening of S-shaped spans', () => {
  it('does not collapse a point-symmetric cubic to its chord', () => {
    const s = 100;
    const ctrl = [
      { x: 0, y: 0 }, { x: 0, y: s }, { x: s, y: -s }, { x: s, y: 0 },
    ];
    const pts = bsplinePointsMm(3, ctrl, [0, 0, 0, 0, 1, 1, 1, 1], undefined, false)!;
    expect(pts.length).toBeGreaterThan(4);
  });
});

function fakeFont(rings: Array<Array<[number, number]>>): Font {
  const commands: Array<{ type: string; x?: number; y?: number }> = [];
  for (const r of rings) {
    r.forEach(([x, y], i) => commands.push({ type: i === 0 ? 'M' : 'L', x, y }));
    commands.push({ type: 'Z' });
  }
  const glyph = { advanceWidth: 1000, getPath: () => ({ commands }) };
  return {
    unitsPerEm: 1000,
    tables: { os2: { sCapHeight: 700 } },
    charToGlyph: () => glyph,
    getKerningValue: () => 0,
  } as unknown as Font;
}

describe('text-to-polygon grouping', () => {
  const sq = (a: number, b: number): Array<[number, number]> => [[a, a], [b, a], [b, b], [a, b]];
  it('keeps islands inside holes (even-depth rings are outers)', () => {
    const font = fakeFont([sq(0, 600), sq(100, 500), sq(200, 400)]);
    const polys = textToPolygons('@', font, 700, 0, 0, 0, '0');
    expect(polys.length).toBe(2);
    const total = polys.reduce((s, p) => s + polyArea(p), 0);
    expect(total).toBeGreaterThan(0);
    const expected = 600 * 600 - 400 * 400 + 200 * 200;
    // scale is 1 (capHeight 700 / 700)
    expect(Math.round(total)).toBe(expected);
  });
  it('skips a degenerate ring instead of throwing', () => {
    const font = fakeFont([sq(0, 600), [[700, 0], [800, 0], [900, 0]]]);
    expect(() => textToPolygons('A', font, 700, 0, 0, 0, '0')).not.toThrow();
    expect(textToPolygons('A', font, 700, 0, 0, 0, '0').length).toBeGreaterThanOrEqual(1);
  });
});

describe('cut short chord', () => {
  it('classifies a 1um slot chord correctly', () => {
    const outer: Ring = [
      [0, 0], [9, 0], [9, 10], [10, 10], [10, 0], [20, 0], [20, 20], [0, 20],
    ].map(([x, y]) => vertex(x, y));
    const poly = normalize({ id: newId(), outer, holes: [], layer: '0' });
    const r = cutPolygon(poly, vertex(-5, 5), vertex(25, 5));
    if (r.status === 'cut') {
      const total = r.pieces.reduce((s, p) => s + polyArea(p), 0);
      expect(Math.round(total)).toBe(Math.round(polyArea(poly)));
    }
  });
});

describe('areEdgesParallel', () => {
  it('does not throw on non-integer coordinates', () => {
    const a: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 0, y: 0 }, { x: 10.5, y: 0 }];
    const b: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 0, y: 5.25 }, { x: 10.5, y: 5.25 }];
    expect(() => areEdgesParallel(a, b)).not.toThrow();
    expect(areEdgesParallel(a, b)).toBe(true);
  });
});

describe('transform rounds float deltas', () => {
  const base = rectToPolygon(0, 0, 100, 100, '0');
  const sel = [{ shapeId: base.id }] as never;
  it('moveShapes', () => {
    const r = moveShapes([base], sel, 10.4, 3.6);
    expect(allInt(r[0])).toBe(true);
  });
  it('copyShapes', () => {
    const r = copyShapes([base], sel, 10.4, 3.6);
    expect(r.every(allInt)).toBe(true);
  });
  it('arrayCopyShapes', () => {
    const r = arrayCopyShapes([base], sel, 2, 2, 10.4, 3.6);
    expect(r.every(allInt)).toBe(true);
  });
});

describe('fillet radius validation', () => {
  const ring = rectToPolygon(0, 0, 1000, 1000, '0').outer;
  it('rejects negative / non-finite radii', () => {
    for (const R of [-50, 0, NaN, Infinity]) {
      const r = applyFillet(ring, 0, R);
      expect(r.skipped).toBe(true);
      const all = roundAllCorners(ring, R);
      expect(all.applied).toBe(0);
      expect(all.ring.length).toBe(ring.length);
    }
  });
});
