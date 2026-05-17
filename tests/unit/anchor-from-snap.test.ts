import { describe, it, expect } from 'vitest';
import { snapToDimensionAnchor } from '../../src/core/anchor-from-snap';
import type { SnapResult } from '../../src/core/snap';

describe('snapToDimensionAnchor', () => {
  it('vertex snap → vertex anchor', () => {
    const snap: SnapResult = {
      point: { x: 100, y: 200 },
      kind: 'vertex',
      ref: { kind: 'vertex', shapeId: 'sh1', ringIndex: -1, vertexId: 'v1' },
    };
    const anchor = snapToDimensionAnchor(snap);
    expect(anchor.kind).toBe('vertex');
    if (anchor.kind === 'vertex') {
      expect(anchor.shapeId).toBe('sh1');
      expect(anchor.vertexId).toBe('v1');
      expect(anchor.cachedPoint).toEqual({ x: 100, y: 200 });
    }
  });

  it('edge snap → edge anchor with t', () => {
    const snap: SnapResult = {
      point: { x: 300, y: 0 },
      kind: 'edge',
      ref: { kind: 'edge', shapeId: 'sh2', ringIndex: -1, edgeStartId: 'a', edgeEndId: 'b', t: 0.3 },
    };
    const anchor = snapToDimensionAnchor(snap);
    expect(anchor.kind).toBe('edge');
    if (anchor.kind === 'edge') {
      expect(anchor.shapeId).toBe('sh2');
      expect(anchor.edgeStartId).toBe('a');
      expect(anchor.edgeEndId).toBe('b');
      expect(anchor.t).toBe(0.3);
      expect(anchor.cachedPoint).toEqual({ x: 300, y: 0 });
    }
  });

  it('midpoint snap → free anchor', () => {
    const snap: SnapResult = {
      point: { x: 500, y: 0 },
      kind: 'midpoint',
      ref: { kind: 'midpoint', shapeId: 'sh1', ringIndex: -1, edgeStartId: 'a', edgeEndId: 'b' },
    };
    const anchor = snapToDimensionAnchor(snap);
    expect(anchor.kind).toBe('free');
    if (anchor.kind === 'free') {
      expect(anchor.point).toEqual({ x: 500, y: 0 });
    }
  });

  it('grid snap → free anchor', () => {
    const snap: SnapResult = { point: { x: 1000, y: 2000 }, kind: 'grid' };
    const anchor = snapToDimensionAnchor(snap);
    expect(anchor.kind).toBe('free');
    if (anchor.kind === 'free') {
      expect(anchor.point).toEqual({ x: 1000, y: 2000 });
    }
  });

  it('center snap → free anchor', () => {
    const snap: SnapResult = {
      point: { x: 0, y: 0 },
      kind: 'center',
      ref: { kind: 'center', shapeId: 'sh1', ringIndex: -1 },
    };
    const anchor = snapToDimensionAnchor(snap);
    expect(anchor.kind).toBe('free');
  });
});
