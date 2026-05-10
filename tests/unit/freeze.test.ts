import { describe, it, expect } from 'vitest';
import { createDefaultState } from '../../src/types';
import {
  AddShapeCommand,
  DeleteCommand,
  AddDimensionCommand,
} from '../../src/state/commands';
import { rectToPolygon } from '../../src/core/geometry';
import { findVertexAnchor, findEdgeAnchor } from '../../src/core/anchor-pick';
import { resolveDimension } from '../../src/core/dimension-resolve';
import { centerlineEndpoints } from '../../src/core/centerline-geometry';
import { newId } from '../../src/types';
import type { Dimension } from '../../src/types';

/**
 * Build a linear-h dimension that anchors to two vertices of a rectangle.
 * rect = rectToPolygon(0, 0, 2000, 1000, '0')  → 4 vertices at corners
 */
function buildLinearDim(state: ReturnType<typeof createDefaultState>): Dimension {
  const shapes = state.shapes;
  // top-left corner (0,0) and top-right corner (2000,0)
  const a1 = findVertexAnchor({ x: 0, y: 0 }, shapes, 100);
  const a2 = findVertexAnchor({ x: 2000, y: 0 }, shapes, 100);
  if (!a1 || !a2) throw new Error('vertex anchor not found');
  return {
    id: newId(),
    kind: 'linear-h',
    anchor1: a1,
    anchor2: a2,
    offset: -500,
    layer: 'DIMENSIONS',
    frozen: false,
  };
}

/**
 * Build a centerline dimension between bottom edge of rect1 and top edge of rect2.
 * rect1 = (0,0)→(2000,1000), rect2 = (0,1200)→(2000,2000)
 */
function buildCenterlineDim(state: ReturnType<typeof createDefaultState>): Dimension {
  const shapes = state.shapes;
  // bottom edge of rect1: midpoint at (1000, 1000)
  const a1 = findEdgeAnchor({ x: 1000, y: 1000 }, shapes, 200);
  // top edge of rect2: midpoint at (1000, 1200)
  const a2 = findEdgeAnchor({ x: 1000, y: 1200 }, shapes, 200);
  if (!a1 || !a2) throw new Error('edge anchor not found');
  // Compute initial cachedPoint for centerline endpoints
  const e1 = [shapes.find(s => s.id === (a1 as any).shapeId)!.outer.find(v => v.id === (a1 as any).edgeStartId)!, shapes.find(s => s.id === (a1 as any).shapeId)!.outer.find(v => v.id === (a1 as any).edgeEndId)!] as [import('../../src/types').Point, import('../../src/types').Point];
  const e2 = [shapes.find(s => s.id === (a2 as any).shapeId)!.outer.find(v => v.id === (a2 as any).edgeStartId)!, shapes.find(s => s.id === (a2 as any).shapeId)!.outer.find(v => v.id === (a2 as any).edgeEndId)!] as [import('../../src/types').Point, import('../../src/types').Point];
  const cl = centerlineEndpoints(e1, e2);
  const cached1 = cl?.p1 ?? { x: 0, y: 1000 };
  const cached2 = cl?.p2 ?? { x: 2000, y: 1000 };
  return {
    id: newId(),
    kind: 'centerline',
    anchor1: { ...a1, kind: 'edge', cachedPoint: cached1 } as any,
    anchor2: { ...a2, kind: 'edge', cachedPoint: cached2 } as any,
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

    // Delete the shape
    const sel = [{ type: 'polygon' as const, shapeId: rect.id, index: -1, holeIndex: -1 }];
    const deleteCmd = new DeleteCommand(sel);
    s = deleteCmd.do(s);

    expect(s.shapes).toHaveLength(0);
    expect(s.dimensions[0].frozen).toBe(true);

    const resolved = resolveDimension(s.dimensions[0], s.shapes);
    expect(resolved.frozen).toBe(true);
    // Frozen: should still have the last known positions
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

    // Undo delete → shape restored, dimension unfreezes
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
