import { describe, it, expect } from 'vitest';
import { createDefaultState } from '../../src/types';
import {
  AddShapeCommand,
  DeleteCommand,
  AddDimensionCommand,
} from '../../src/state/commands';
import { rectToPolygon } from '../../src/core/geometry';
import { resolveDimension } from '../../src/core/dimension-resolve';
import { centerlineEndpoints } from '../../src/core/centerline-geometry';
import { newId } from '../../src/types';
import type { Dimension, Polygon } from '../../src/types';

function vertexAt(shape: Polygon, x: number, y: number) {
  const v = shape.outer.find((p) => p.x === x && p.y === y);
  if (!v) throw new Error(`vertex not found at (${x},${y})`);
  return v;
}

function edgeAt(shape: Polygon, x1: number, y1: number, x2: number, y2: number) {
  const a = vertexAt(shape, x1, y1);
  const b = vertexAt(shape, x2, y2);
  return { a, b };
}

/**
 * Build a linear-h dimension anchored to two vertices of a rectangle.
 */
function buildLinearDim(state: ReturnType<typeof createDefaultState>): Dimension {
  const shape = state.shapes[0];
  const v1 = vertexAt(shape, 0, 0);
  const v2 = vertexAt(shape, 2000, 0);
  return {
    id: newId(),
    kind: 'linear-h',
    anchor1: { kind: 'vertex', shapeId: shape.id, ringIndex: -1, vertexId: v1.id, cachedPoint: { x: 0, y: 0 } },
    anchor2: { kind: 'vertex', shapeId: shape.id, ringIndex: -1, vertexId: v2.id, cachedPoint: { x: 2000, y: 0 } },
    offset: -500,
    layer: 'DIMENSIONS',
    frozen: false,
  };
}

/**
 * Build a centerline dimension between bottom edge of rect1 and top edge of rect2.
 */
function buildCenterlineDim(state: ReturnType<typeof createDefaultState>): Dimension {
  const rect1 = state.shapes[0];
  const rect2 = state.shapes[1];
  const { a: r1a, b: r1b } = edgeAt(rect1, 0, 1000, 2000, 1000);
  const { a: r2a, b: r2b } = edgeAt(rect2, 0, 1200, 2000, 1200);
  const cl = centerlineEndpoints([r1a, r1b], [r2a, r2b]);
  return {
    id: newId(),
    kind: 'centerline',
    anchor1: { kind: 'edge', shapeId: rect1.id, ringIndex: -1, edgeStartId: r1a.id, edgeEndId: r1b.id, t: 0.5, cachedPoint: cl?.p1 ?? { x: 0, y: 1000 } },
    anchor2: { kind: 'edge', shapeId: rect2.id, ringIndex: -1, edgeStartId: r2a.id, edgeEndId: r2b.id, t: 0.5, cachedPoint: cl?.p2 ?? { x: 0, y: 1200 } },
    offset: 0,
    layer: 'DIMENSIONS',
    frozen: false,
  };
}

describe('Freeze mechanism — linear dimension', () => {
  it('dimension resolves live when shape exists', () => {
    let s = createDefaultState();
    const rect = rectToPolygon(0, 0, 2000, 1000, '0');
    s = new AddShapeCommand(rect).do(s);

    const dim = buildLinearDim(s);
    s = new AddDimensionCommand(dim).do(s);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(false);
    expect(resolved.p1).toMatchObject({ x: 0, y: 0 });
    expect(resolved.p2).toMatchObject({ x: 2000, y: 0 });
  });

  it('dimension freezes when referenced shape is deleted', () => {
    let s = createDefaultState();
    const rect = rectToPolygon(0, 0, 2000, 1000, '0');
    s = new AddShapeCommand(rect).do(s);
    const dim = buildLinearDim(s);
    s = new AddDimensionCommand(dim).do(s);

    const sel = [{ type: 'polygon' as const, shapeId: rect.id, index: -1, holeIndex: -1 }];
    const deleteCmd = new DeleteCommand(sel);
    s = deleteCmd.do(s);

    expect(s.shapes).toHaveLength(0);
    expect(s.dimensions[0].frozen).toBe(true);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(true);
    expect(resolved.p1).toMatchObject({ x: 0, y: 0 });
    expect(resolved.p2).toMatchObject({ x: 2000, y: 0 });
  });

  it('dimension unfreezes after undo of delete', () => {
    let s = createDefaultState();
    const rect = rectToPolygon(0, 0, 2000, 1000, '0');
    s = new AddShapeCommand(rect).do(s);
    const dim = buildLinearDim(s);
    s = new AddDimensionCommand(dim).do(s);

    const sel = [{ type: 'polygon' as const, shapeId: rect.id, index: -1, holeIndex: -1 }];
    const deleteCmd = new DeleteCommand(sel);
    s = deleteCmd.do(s);
    expect(s.dimensions[0].frozen).toBe(true);

    s = deleteCmd.undo(s);
    expect(s.shapes).toHaveLength(1);
    expect(s.dimensions[0].frozen).toBe(false);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(false);
    expect(resolved.p1).toMatchObject({ x: 0, y: 0 });
    expect(resolved.p2).toMatchObject({ x: 2000, y: 0 });
  });
});

describe('Freeze mechanism — centerline dimension', () => {
  it('centerline resolves live when both shapes exist', () => {
    let s = createDefaultState();
    const rect1 = rectToPolygon(0, 0, 2000, 1000, '0');
    const rect2 = rectToPolygon(0, 1200, 2000, 2000, '0');
    s = new AddShapeCommand(rect1).do(s);
    s = new AddShapeCommand(rect2).do(s);

    const dim = buildCenterlineDim(s);
    s = new AddDimensionCommand(dim).do(s);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(false);
  });

  it('centerline freezes when one referenced shape is deleted', () => {
    let s = createDefaultState();
    const rect1 = rectToPolygon(0, 0, 2000, 1000, '0');
    const rect2 = rectToPolygon(0, 1200, 2000, 2000, '0');
    s = new AddShapeCommand(rect1).do(s);
    s = new AddShapeCommand(rect2).do(s);

    const dim = buildCenterlineDim(s);
    s = new AddDimensionCommand(dim).do(s);

    const sel = [{ type: 'polygon' as const, shapeId: rect1.id, index: -1, holeIndex: -1 }];
    const deleteCmd = new DeleteCommand(sel);
    s = deleteCmd.do(s);

    expect(s.shapes).toHaveLength(1);
    expect(s.dimensions[0].frozen).toBe(true);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(true);
  });

  it('centerline unfreezes after undo of delete', () => {
    let s = createDefaultState();
    const rect1 = rectToPolygon(0, 0, 2000, 1000, '0');
    const rect2 = rectToPolygon(0, 1200, 2000, 2000, '0');
    s = new AddShapeCommand(rect1).do(s);
    s = new AddShapeCommand(rect2).do(s);

    const dim = buildCenterlineDim(s);
    s = new AddDimensionCommand(dim).do(s);

    const sel = [{ type: 'polygon' as const, shapeId: rect1.id, index: -1, holeIndex: -1 }];
    const deleteCmd = new DeleteCommand(sel);
    s = deleteCmd.do(s);
    expect(s.dimensions[0].frozen).toBe(true);

    s = deleteCmd.undo(s);
    expect(s.shapes).toHaveLength(2);
    expect(s.dimensions[0].frozen).toBe(false);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(false);
  });
});
