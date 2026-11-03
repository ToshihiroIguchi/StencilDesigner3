import { describe, it, expect } from 'vitest';
import { createDefaultState, newId } from '../../src/types';
import type { Dimension, Polygon, ViewTransform } from '../../src/types';
import { rectToPolygon, polygonsOverlap, polygonEdgeDistance } from '../../src/core/geometry';
import { normalize } from '../../src/normalize';
import { hitTest } from '../../src/core/selection';
import { FilletCommand, FilletAllCommand } from '../../src/state/commands';
import { resolveDimension } from '../../src/core/dimension-resolve';

function normalizeTri(pts: number[][]): Polygon {
  const p: Polygon = { id: newId(), outer: pts.map(([x, y]) => ({ x, y, id: newId() })), holes: [], layer: '0' };
  return normalize(p);
}

describe('polygonsOverlap with shared/collinear boundaries', () => {
  it('rectangles overlapping along collinear edges overlap', () => {
    const a = rectToPolygon(0, 0, 10000, 10000);
    const b = rectToPolygon(5000, 0, 15000, 10000);
    expect(polygonsOverlap(a, b)).toBe(true);
    expect(polygonEdgeDistance(a, b).dist).toBe(0);
  });
  it('triangle sharing part of the right edge, with first vertex on it, overlaps', () => {
    const a = rectToPolygon(0, 0, 10000, 10000);
    // CCW in the screen sense used by normalize is irrelevant here; normalize reorders as needed
    const tri = normalizeTri([[10000, 5000], [10000, 8000], [6000, 6000]]);
    expect(polygonsOverlap(a, tri)).toBe(true);
    expect(polygonsOverlap(tri, a)).toBe(true);
    expect(polygonEdgeDistance(a, tri).dist).toBe(0);
  });
  it('identical rectangles overlap', () => {
    const a = rectToPolygon(0, 0, 10000, 10000);
    const b = rectToPolygon(0, 0, 10000, 10000);
    expect(polygonsOverlap(a, b)).toBe(true);
  });
  it('rectangle inside another sharing a corner overlaps', () => {
    const a = rectToPolygon(0, 0, 10000, 10000);
    const b = rectToPolygon(0, 0, 4000, 4000);
    expect(polygonsOverlap(a, b)).toBe(true);
  });
  it('merely touching edges are not an area overlap but distance is 0', () => {
    const a = rectToPolygon(0, 0, 10000, 10000);
    const b = rectToPolygon(10000, 0, 20000, 10000);
    expect(polygonsOverlap(a, b)).toBe(false);
    expect(polygonEdgeDistance(a, b).dist).toBe(0);
  });
  it('separated rectangles do not overlap', () => {
    const a = rectToPolygon(0, 0, 10000, 10000);
    const b = rectToPolygon(11000, 0, 20000, 10000);
    expect(polygonsOverlap(a, b)).toBe(false);
  });
});

describe('hitTest nearest / topmost', () => {
  const vt: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
  it('prefers the nearest vertex over an earlier farther one', () => {
    const a = rectToPolygon(0, 0, 1000, 1000);
    const b = rectToPolygon(8, 0, 1008, 1000);
    // cursor at (7,0): b's vertex (8,0) dist 1, a's vertex (0,0) dist 7
    const hit = hitTest(7, 0, [a, b], vt, 10);
    expect(hit?.type).toBe('vertex');
    expect(hit?.shapeId).toBe(b.id);
  });
  it('prefers the topmost shape on exact ties', () => {
    const a = rectToPolygon(0, 0, 1000, 1000);
    const b = rectToPolygon(0, 0, 1000, 1000);
    expect(hitTest(0, 0, [a, b], vt, 10)?.shapeId).toBe(b.id);
  });
  it('prefers a vertex over a nearer edge', () => {
    const a = rectToPolygon(0, 0, 1000, 1000);
    const hit = hitTest(2, 3, [a], vt, 10);
    expect(hit?.type).toBe('vertex');
  });
  it('picks the nearest edge', () => {
    const a = rectToPolygon(0, 0, 1000, 1000);
    const b = rectToPolygon(0, 6, 1000, 1006);
    const hit = hitTest(500, 4, [a, b], vt, 10);
    expect(hit?.type).toBe('edge');
    expect(hit?.shapeId).toBe(b.id);
  });
});

function dimOnVertex(shape: Polygon, x: number, y: number, stale: { x: number; y: number }): Dimension {
  const v = shape.outer.find((p) => p.x === x && p.y === y)!;
  const w = shape.outer.find((p) => p.x === 10000 && p.y === 0)!;
  return {
    id: newId(), kind: 'linear-h',
    anchor1: { kind: 'vertex', shapeId: shape.id, ringIndex: -1, vertexId: v.id, cachedPoint: stale },
    anchor2: { kind: 'vertex', shapeId: shape.id, ringIndex: -1, vertexId: w.id, cachedPoint: { x: 10000, y: 0 } },
    offset: -500, layer: 'DIMENSIONS', frozen: false,
  };
}


describe('Fillet freezes dimensions with refreshed cachedPoint', () => {
  it('FilletCommand refreshes stale cache and undo restores', () => {
    const shape = rectToPolygon(0, 0, 10000, 10000);
    const st = { ...createDefaultState(), shapes: [shape] };
    const dim = dimOnVertex(shape, 0, 0, { x: -999, y: -999 }); // stale
    st.dimensions = [dim];
    const newRing = [
      { x: 1000, y: 0, id: newId() }, { x: 10000, y: 0, id: shape.outer[1].id },
      { x: 10000, y: 10000, id: shape.outer[2].id }, { x: 0, y: 10000, id: shape.outer[3].id },
      { x: 0, y: 1000, id: newId() },
    ];
    const cmd = new FilletCommand(shape, -1, newRing);
    const after = cmd.do(st);
    const r = resolveDimension(after.dimensions[0], after.shapes);
    expect(r.frozen).toBe(true);
    expect({ x: r.p1.x, y: r.p1.y }).toEqual({ x: 0, y: 0 });
    const undone = cmd.undo(after);
    expect(undone.dimensions).toEqual([dim]);
  });
  it('FilletAllCommand refreshes stale cache and undo restores', () => {
    const shape = rectToPolygon(0, 0, 10000, 10000);
    const dim = dimOnVertex(shape, 0, 0, { x: -999, y: -999 });
    const st = { ...createDefaultState(), shapes: [shape], dimensions: [dim] };
    const afterShape: Polygon = { ...shape, outer: [
      { x: 1000, y: 0, id: newId() }, { x: 10000, y: 0, id: shape.outer[1].id },
      { x: 10000, y: 10000, id: shape.outer[2].id }, { x: 0, y: 10000, id: shape.outer[3].id },
      { x: 0, y: 1000, id: newId() },
    ] };
    const cmd = new FilletAllCommand([shape], [afterShape]);
    const after = cmd.do(st);
    const r = resolveDimension(after.dimensions[0], after.shapes);
    expect(r.frozen).toBe(true);
    expect({ x: r.p1.x, y: r.p1.y }).toEqual({ x: 0, y: 0 });
    expect(cmd.undo(after).dimensions).toEqual([dim]);
  });
});
