import { describe, it, expect } from 'vitest';
import { normalize, normalizeAll, area, bbox, signedArea2, pointInRing } from '../../src/normalize';
import type { Polygon, Ring } from '../../src/types';

function makeRect(x1: number, y1: number, x2: number, y2: number): Polygon {
  return {
    id: 'test',
    layer: '0',
    holes: [],
    outer: [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
    ],
  };
}

describe('normalize', () => {
  it('removes duplicate consecutive points', () => {
    const poly: Polygon = {
      id: 'test',
      layer: '0',
      holes: [],
      outer: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 0 }, // duplicate
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    };
    const result = normalize(poly);
    expect(result.outer.length).toBe(4);
  });

  it('removes collinear points', () => {
    const poly: Polygon = {
      id: 'test',
      layer: '0',
      holes: [],
      outer: [
        { x: 0, y: 0 },
        { x: 50, y: 0 }, // collinear with prev and next
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    };
    const result = normalize(poly);
    expect(result.outer.length).toBe(4);
  });

  it('enforces CCW orientation for outer ring', () => {
    // CW rectangle
    const poly: Polygon = {
      id: 'test',
      layer: '0',
      holes: [],
      outer: [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: 0 },
      ],
    };
    const result = normalize(poly);
    expect(signedArea2(result.outer)).toBeGreaterThan(0); // CCW = positive
  });

  it('enforces CW orientation for holes', () => {
    const outer: Ring = [
      { x: 0, y: 0 }, { x: 200, y: 0 },
      { x: 200, y: 200 }, { x: 0, y: 200 },
    ];
    // CCW hole (will be reversed to CW)
    const hole: Ring = [
      { x: 50, y: 50 }, { x: 150, y: 50 },
      { x: 150, y: 150 }, { x: 50, y: 150 },
    ];
    const poly: Polygon = { id: 'test', layer: '0', outer, holes: [hole] };
    const result = normalize(poly);
    expect(signedArea2(result.holes[0])).toBeLessThan(0); // CW = negative
  });

  it('removes explicit closure point (last == first)', () => {
    const poly: Polygon = {
      id: 'test',
      layer: '0',
      holes: [],
      outer: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
        { x: 0, y: 0 }, // explicit closure
      ],
    };
    const result = normalize(poly);
    const first = result.outer[0];
    const last = result.outer[result.outer.length - 1];
    expect(first.x === last.x && first.y === last.y).toBe(false);
  });

  it('throws for degenerate polygon (< 3 points)', () => {
    const poly: Polygon = {
      id: 'test',
      layer: '0',
      holes: [],
      outer: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    };
    expect(() => normalize(poly)).toThrow();
  });
});

describe('normalizeAll', () => {
  it('filters degenerate polygons', () => {
    const good = makeRect(0, 0, 100, 100);
    const bad: Polygon = { id: 'bad', layer: '0', holes: [], outer: [{ x: 0, y: 0 }] };
    const result = normalizeAll([good, bad]);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('test');
  });
});

describe('area', () => {
  it('computes correct area for a rectangle', () => {
    const ring: Ring = [
      { x: 0, y: 0 }, { x: 1000, y: 0 },
      { x: 1000, y: 500 }, { x: 0, y: 500 },
    ];
    expect(area(ring)).toBe(500000); // 1000µm * 500µm
  });

  it('computes correct area for a unit square', () => {
    const ring: Ring = [
      { x: 0, y: 0 }, { x: 1, y: 0 },
      { x: 1, y: 1 }, { x: 0, y: 1 },
    ];
    expect(area(ring)).toBe(1);
  });
});

describe('bbox', () => {
  it('returns correct bounding box', () => {
    const ring: Ring = [
      { x: 10, y: 20 }, { x: 100, y: 20 },
      { x: 100, y: 80 }, { x: 10, y: 80 },
    ];
    const bb = bbox(ring);
    expect(bb).toEqual({ minX: 10, minY: 20, maxX: 100, maxY: 80 });
  });
});

describe('pointInRing', () => {
  const ring: Ring = [
    { x: 0, y: 0 }, { x: 100, y: 0 },
    { x: 100, y: 100 }, { x: 0, y: 100 },
  ];

  it('returns true for interior point', () => {
    expect(pointInRing({ x: 50, y: 50 }, ring)).toBe(true);
  });

  it('returns false for exterior point', () => {
    expect(pointInRing({ x: 150, y: 50 }, ring)).toBe(false);
    expect(pointInRing({ x: -10, y: 50 }, ring)).toBe(false);
  });
});
