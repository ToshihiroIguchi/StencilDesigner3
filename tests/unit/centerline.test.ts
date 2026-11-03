import { describe, it, expect } from 'vitest';
import { createDefaultState } from '../../src/types';
import { AddDimensionCommand, DeleteDimensionCommand } from '../../src/state/commands';
import { hitTestDimension } from '../../src/core/selection';
import { centerlineEndpoints } from '../../src/core/centerline-geometry';
import type { Dimension, ViewTransform } from '../../src/types';

function makeCenterline(p1x: number, p1y: number, p2x: number, p2y: number): Dimension {
  return {
    id: 'cl_test',
    kind: 'centerline',
    anchor1: { kind: 'free', point: { x: p1x, y: p1y } },
    anchor2: { kind: 'free', point: { x: p2x, y: p2y } },
    offset: 0,
    layer: 'DIMENSIONS',
    frozen: false,
  };
}

const VT: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

describe('Centerline (Dimension kind=centerline)', () => {
  it('AddDimensionCommand stores centerline kind', () => {
    const s = createDefaultState();
    const cl = makeCenterline(0, 0, 5000, 0);
    const s2 = new AddDimensionCommand(cl).do(s);
    expect(s2.dimensions).toHaveLength(1);
    expect(s2.dimensions[0].kind).toBe('centerline');
    expect(s2.dimensions[0].offset).toBe(0);
  });

  it('AddDimensionCommand undo removes centerline', () => {
    const s = createDefaultState();
    const cl = makeCenterline(0, 0, 5000, 0);
    const cmd = new AddDimensionCommand(cl);
    const s2 = cmd.do(s);
    const s3 = cmd.undo(s2);
    expect(s3.dimensions).toHaveLength(0);
  });

  it('DeleteDimensionCommand removes centerline and undo restores', () => {
    const s = createDefaultState();
    const cl = makeCenterline(0, 0, 5000, 0);
    const s2 = new AddDimensionCommand(cl).do(s);
    const cmd = new DeleteDimensionCommand(cl.id);
    const s3 = cmd.do(s2);
    expect(s3.dimensions).toHaveLength(0);
    const s4 = cmd.undo(s3);
    expect(s4.dimensions).toHaveLength(1);
    expect(s4.dimensions[0].kind).toBe('centerline');
  });

  it('hitTestDimension hits centerline endpoint (p1)', () => {
    const cl = makeCenterline(0, 0, 5000, 0);
    const hit = hitTestDimension(0, 0, [cl], [], VT, 10);
    expect(hit).not.toBeNull();
    expect(hit?.part).toBe('p1');
  });

  it('hitTestDimension hits centerline endpoint (p2)', () => {
    const cl = makeCenterline(0, 0, 5000, 0);
    const hit = hitTestDimension(5000, 0, [cl], [], VT, 10);
    expect(hit).not.toBeNull();
    expect(hit?.part).toBe('p2');
  });

  it('hitTestDimension hits centerline body', () => {
    const cl = makeCenterline(0, 0, 5000, 0);
    // midpoint (2500, 0) is on the horizontal centerline; snapRadius large enough
    const hit = hitTestDimension(2500, 0, [cl], [], VT, 10);
    expect(hit).not.toBeNull();
    expect(hit?.part).toBe('dimLine');
  });

  it('centerlineEndpoints for non-parallel edges places centerline between edges rather than at distant intersection', () => {
    // Two slightly tapered vertical-ish edges at y=1000..2000, x around 1000 and 2000
    // Edge 1: (950, 1000) to (1050, 2000)
    // Edge 2: (2050, 1000) to (1950, 2000)
    const e1: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 950, y: 1000 },
      { x: 1050, y: 2000 },
    ];
    const e2: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 2050, y: 1000 },
      { x: 1950, y: 2000 },
    ];
    const cl = centerlineEndpoints(e1, e2);
    expect(cl).not.toBeNull();
    if (!cl) return;

    // Centerline should be near x=1500 (between the two edges) and spanning y around 1000..2000
    expect(cl.p1.x).toBeCloseTo(1500, -2);
    expect(cl.p2.x).toBeCloseTo(1500, -2);
    expect(Math.min(cl.p1.y, cl.p2.y)).toBeLessThanOrEqual(1000);
    expect(Math.max(cl.p1.y, cl.p2.y)).toBeGreaterThanOrEqual(2000);
  });
});
