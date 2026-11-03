import { describe, it, expect } from 'vitest';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import type { Dimension, Layer, Selection } from '../../src/types';
import {
  AddShapeCommand, DuplicateCommand, UnionCommand, DifferenceCommand, MoveCommand,
  AddLayerCommand, RenameLayerCommand,
} from '../../src/state/commands';
import { rectToPolygon } from '../../src/core/geometry';

const sel = (id: string): Selection => ({ type: 'polygon', shapeId: id, index: -1, holeIndex: -1 });
const ids = (h: History) => h.state.shapes.map((s) => s.id).sort();

describe('stable ids across redo', () => {
  it('DuplicateCommand reuses copy ids on redo', () => {
    const h = new History(createDefaultState());
    const a = rectToPolygon(0, 0, 1000, 1000);
    h.execute(new AddShapeCommand(a));
    h.execute(new DuplicateCommand([sel(a.id)], 1, 0, 5000, 0));
    const afterDo = ids(h);
    expect(afterDo).toHaveLength(2);
    h.undo();
    expect(ids(h)).toEqual([a.id]);
    h.redo();
    expect(ids(h)).toEqual(afterDo);
  });

  it('UnionCommand reuses result ids on redo', () => {
    const h = new History(createDefaultState());
    const a = rectToPolygon(0, 0, 1000, 1000);
    const b = rectToPolygon(500, 0, 1500, 1000);
    h.execute(new AddShapeCommand(a));
    h.execute(new AddShapeCommand(b));
    h.execute(new UnionCommand([sel(a.id), sel(b.id)]));
    const afterDo = ids(h);
    expect(afterDo).toHaveLength(1);
    h.undo();
    expect(ids(h)).toEqual([a.id, b.id].sort());
    h.redo();
    expect(ids(h)).toEqual(afterDo);
  });

  it('DifferenceCommand reuses result ids on redo', () => {
    const h = new History(createDefaultState());
    const a = rectToPolygon(0, 0, 2000, 2000);
    const b = rectToPolygon(500, 500, 1500, 1500);
    h.execute(new AddShapeCommand(a));
    h.execute(new AddShapeCommand(b));
    h.execute(new DifferenceCommand(sel(a.id), sel(b.id)));
    const afterDo = ids(h);
    h.undo();
    h.redo();
    expect(ids(h)).toEqual(afterDo);
  });
});

const dim = (): Dimension => ({
  id: 'd1', kind: 'linear-h', offset: 100, layer: 'DIMENSIONS', frozen: false,
  anchor1: { kind: 'free', point: { x: 0, y: 0 } },
  anchor2: { kind: 'free', point: { x: 10, y: 0 } },
});

describe('no-op do() makes undo a no-op', () => {
  it('UnionCommand with <2 targets does not wipe dimensions on undo', () => {
    const h = new History({ ...createDefaultState(), dimensions: [dim()] });
    const a = rectToPolygon(0, 0, 1000, 1000);
    h.execute(new AddShapeCommand(a));
    h.execute(new UnionCommand([sel(a.id)]));
    // Dimensions edited after (not via command) must survive an undo of the no-op union.
    h.undo();
    expect(h.state.dimensions).toHaveLength(1);
  });

  const layer: Layer = {
    name: '0', color: '#fff', linetype: 'CONTINUOUS', lineweight: -1,
    visible: true, locked: false, plot: true, isAperture: true,
  };

  it('AddLayerCommand duplicate name: undo keeps existing layer', () => {
    const s = createDefaultState();
    const c = new AddLayerCommand({ ...layer });
    const s2 = c.do(s);
    expect(c.undo(s2).layers.map((l) => l.name)).toEqual(['0']);
  });

  it('RenameLayerCommand to existing name: undo is a no-op', () => {
    let s = createDefaultState();
    s = new AddLayerCommand({ ...layer, name: 'B' }).do(s);
    const c = new RenameLayerCommand('B', '0');
    const s2 = c.do(s);
    const s3 = c.undo(s2);
    expect(s3.layers.map((l) => l.name)).toEqual(['0', 'B']);
  });
});

describe('MoveCommand undo restores selected dimension anchors exactly', () => {
  it('restores vertex anchors that the move converted to free', () => {
    const poly = rectToPolygon(0, 0, 1000, 1000);
    const v = poly.outer[0];
    const d: Dimension = {
      id: 'd1', kind: 'linear-h', offset: 100, layer: 'DIMENSIONS', frozen: false,
      anchor1: { kind: 'vertex', shapeId: poly.id, ringIndex: -1, vertexId: v.id!, cachedPoint: { x: v.x, y: v.y } },
      anchor2: { kind: 'free', point: { x: 10, y: 0 } },
    };
    const s0 = { ...createDefaultState(), shapes: [poly], dimensions: [d] };
    const cmd = new MoveCommand([{ type: 'dimension', shapeId: 'd1', index: -1, holeIndex: -1 }], 50, 70);
    const s1 = cmd.do(s0);
    expect(s1.dimensions[0].anchor1.kind).toBe('free');
    const s2 = cmd.undo(s1);
    expect(s2.dimensions[0]).toBe(d);
  });
});
