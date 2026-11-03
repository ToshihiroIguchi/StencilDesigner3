import { describe, it, expect } from 'vitest';
import { roundAllCorners, applyFillet } from '../../src/core/fillet';
import { rectToPolygon } from '../../src/core/geometry';
import { normalize, hasSelfIntersection } from '../../src/normalize';
import { vertex } from '../../src/core/vertex';

describe('roundAllCorners shared edges', () => {
  it('does not self-intersect on a thin rectangle with large R', () => {
    const poly = rectToPolygon(0, 0, 100, 10);
    const res = roundAllCorners(poly.outer, 9);
    expect(hasSelfIntersection(res.ring)).toBe(false);
    expect(res.applied + res.skipped).toBe(4);
  });

  it('still rounds all corners when R fits', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    const res = roundAllCorners(poly.outer, 10);
    expect(res.applied).toBe(4);
    expect(hasSelfIntersection(res.ring)).toBe(false);
  });

  it('single-corner fillet keeps old limit (edge length)', () => {
    const poly = rectToPolygon(0, 0, 100, 10);
    const r = applyFillet(poly.outer, 0, 9);
    expect(r.skipped).toBe(false);
  });
});

describe('normalize degenerate rings', () => {
  it('throws for collinear outer ring', () => {
    const outer = [vertex(0, 0), vertex(10, 0), vertex(5, 0)];
    expect(() => normalize({ ...rectToPolygon(0, 0, 1, 1), outer })).toThrow();
  });

  it('drops collinear holes', () => {
    const p = rectToPolygon(0, 0, 100, 100);
    const hole = [vertex(10, 10), vertex(20, 10), vertex(30, 10)];
    expect(normalize({ ...p, holes: [hole] }).holes).toHaveLength(0);
  });

  it('keeps legitimate polygons', () => {
    const p = normalize(rectToPolygon(0, 0, 100, 100));
    expect(p.outer).toHaveLength(4);
  });
});
