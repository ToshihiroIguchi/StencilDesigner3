import { describe, it, expect } from 'vitest';
import { moveShapes, copyShapes, deleteShapes, arrayCopyShapes } from '../../src/core/transform';
import { rectToPolygon, polygonBbox } from '../../src/core/geometry';
import type { Selection } from '../../src/types';

function makeRect(x1: number, y1: number, x2: number, y2: number) {
  return rectToPolygon(x1, y1, x2, y2);
}

function selAll(shapes: ReturnType<typeof makeRect>[]): Selection[] {
  return shapes.map((s) => ({ type: 'polygon' as const, shapeId: s.id, index: -1, holeIndex: -1 }));
}

describe('moveShapes', () => {
  it('translates selected shapes by (dx, dy)', () => {
    const poly = makeRect(0, 0, 100, 100);
    const sel = selAll([poly]);
    const result = moveShapes([poly], sel, 200, 150);
    const bb = polygonBbox(result[0]);
    expect(bb.minX).toBe(200);
    expect(bb.minY).toBe(150);
  });

  it('does not move unselected shapes', () => {
    const a = makeRect(0, 0, 100, 100);
    const b = makeRect(200, 200, 300, 300);
    const sel: Selection[] = [{ type: 'polygon', shapeId: a.id, index: -1, holeIndex: -1 }];
    const result = moveShapes([a, b], sel, 50, 50);

    const bResult = result.find((s) => s.id === b.id)!;
    const bb = polygonBbox(bResult);
    expect(bb.minX).toBe(200);
  });
});

describe('copyShapes', () => {
  it('appends copies without modifying originals', () => {
    const poly = makeRect(0, 0, 100, 100);
    const sel = selAll([poly]);
    const result = copyShapes([poly], sel, 200, 0);
    expect(result.length).toBe(2);
    // Original stays at 0
    const orig = result.find((s) => s.id === poly.id)!;
    expect(polygonBbox(orig).minX).toBe(0);
    // Copy at 200
    const copy = result.find((s) => s.id !== poly.id)!;
    expect(polygonBbox(copy).minX).toBe(200);
  });
});

describe('deleteShapes', () => {
  it('removes selected shapes', () => {
    const a = makeRect(0, 0, 100, 100);
    const b = makeRect(200, 200, 300, 300);
    const sel = selAll([a]);
    const result = deleteShapes([a, b], sel);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(b.id);
  });
});

describe('arrayCopyShapes', () => {
  it('creates nx*ny-1 copies (original not duplicated)', () => {
    const poly = makeRect(0, 0, 100, 100);
    const sel = selAll([poly]);
    const result = arrayCopyShapes([poly], sel, 3, 2, 500, 500);
    // 3×2=6 total, minus original = 5 copies
    expect(result.length).toBe(6);
  });

  it('places copies at correct positions', () => {
    const poly = makeRect(0, 0, 100, 100);
    const sel = selAll([poly]);
    const result = arrayCopyShapes([poly], sel, 2, 1, 1000, 0);

    const positions = result.map((s) => polygonBbox(s).minX).sort((a, b) => a - b);
    expect(positions).toEqual([0, 1000]);
  });
});
