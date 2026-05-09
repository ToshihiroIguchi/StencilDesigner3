import { describe, it, expect } from 'vitest';
import { rectToPolygon, circleToPolygon, lineToPolygon, translatePolygon, polygonArea, polygonBbox, snapToGrid, dist, isRingCircleLike, ringCentroid } from '../../src/core/geometry';
import { area, signedArea2 } from '../../src/normalize';
import type { Ring } from '../../src/types';

function regularNgon(cx: number, cy: number, r: number, n: number): Ring {
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i * Math.PI * 2) / n;
    ring.push({ x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) });
  }
  return ring;
}

describe('rectToPolygon', () => {
  it('creates a rectangle with correct area', () => {
    const poly = rectToPolygon(0, 0, 1000, 500);
    expect(polygonArea(poly)).toBe(500000);
  });

  it('normalizes swapped corners', () => {
    const poly = rectToPolygon(1000, 500, 0, 0);
    const bb = polygonBbox(poly);
    expect(bb.minX).toBe(0);
    expect(bb.minY).toBe(0);
    expect(bb.maxX).toBe(1000);
    expect(bb.maxY).toBe(500);
  });

  it('outer ring is CCW', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    expect(signedArea2(poly.outer)).toBeGreaterThan(0);
  });
});

describe('circleToPolygon', () => {
  it('approximates area of a circle', () => {
    const r = 1000; // 1mm radius
    const poly = circleToPolygon(0, 0, r, 64);
    const expected = Math.PI * r * r;
    const actual = polygonArea(poly);
    // Within 0.2% of exact area
    expect(Math.abs(actual - expected) / expected).toBeLessThan(0.002);
  });

  it('has no holes', () => {
    const poly = circleToPolygon(0, 0, 500, 32);
    expect(poly.holes.length).toBe(0);
  });

  it('produces integer coordinates', () => {
    const poly = circleToPolygon(100, 200, 500, 32);
    for (const p of poly.outer) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });
});

describe('translatePolygon', () => {
  it('moves all vertices by (dx, dy)', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    const moved = translatePolygon(poly, 50, 30);
    const bb = polygonBbox(moved);
    expect(bb.minX).toBe(50);
    expect(bb.minY).toBe(30);
    expect(bb.maxX).toBe(150);
    expect(bb.maxY).toBe(130);
  });

  it('assigns a new ID', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    const moved = translatePolygon(poly, 10, 10);
    expect(moved.id).not.toBe(poly.id);
  });

  it('preserves area after translation', () => {
    const poly = rectToPolygon(0, 0, 500, 300);
    const moved = translatePolygon(poly, 1000, -2000);
    expect(polygonArea(moved)).toBe(polygonArea(poly));
  });
});

describe('snapToGrid', () => {
  it('snaps to nearest grid point', () => {
    expect(snapToGrid({ x: 1450, y: 2750 }, 1000)).toEqual({ x: 1000, y: 3000 });
    expect(snapToGrid({ x: 500, y: 500 }, 1000)).toEqual({ x: 1000, y: 1000 });
    expect(snapToGrid({ x: 0, y: 0 }, 1000)).toEqual({ x: 0, y: 0 });
  });
});

describe('dist', () => {
  it('calculates Euclidean distance', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(dist({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });
});

describe('isRingCircleLike', () => {
  it('detects a 64-sided circle (default circleToPolygon)', () => {
    expect(isRingCircleLike(circleToPolygon(0, 0, 1000).outer)).toBe(true);
  });

  it('detects a small 64-sided circle (radius 50µm) — covers absolute tolerance', () => {
    expect(isRingCircleLike(circleToPolygon(0, 0, 50).outer)).toBe(true);
  });

  it('detects a tiny 64-sided circle (radius 30µm) — DRC-scale aperture', () => {
    expect(isRingCircleLike(circleToPolygon(0, 0, 30).outer)).toBe(true);
  });

  it('rejects a rectangle (4 vertices)', () => {
    expect(isRingCircleLike(rectToPolygon(0, 0, 1000, 1000).outer)).toBe(false);
  });

  it('rejects an octagon (8 vertices, below threshold)', () => {
    expect(isRingCircleLike(regularNgon(0, 0, 1000, 8))).toBe(false);
  });

  it('rejects an 11-gon (just below threshold)', () => {
    expect(isRingCircleLike(regularNgon(0, 0, 1000, 11))).toBe(false);
  });

  it('accepts a 12-gon (at threshold)', () => {
    expect(isRingCircleLike(regularNgon(0, 0, 1000, 12))).toBe(true);
  });

  it('rejects a deformed circle (one vertex moved by 100µm)', () => {
    const ring = circleToPolygon(0, 0, 1000).outer.map((p, i) =>
      i === 0 ? { x: p.x + 100, y: p.y } : p
    );
    expect(isRingCircleLike(ring)).toBe(false);
  });

  it('rejects a degenerate ring (all points coincident)', () => {
    const ring: Ring = Array(20).fill({ x: 0, y: 0 });
    expect(isRingCircleLike(ring)).toBe(false);
  });
});

describe('ringCentroid', () => {
  it('returns the center of a circle (within 1µm rounding tolerance)', () => {
    const c = ringCentroid(circleToPolygon(500, 300, 1000).outer);
    expect(Math.abs(c.x - 500)).toBeLessThanOrEqual(1);
    expect(Math.abs(c.y - 300)).toBeLessThanOrEqual(1);
  });

  it('returns the center of a rectangle', () => {
    const c = ringCentroid(rectToPolygon(0, 0, 1000, 1000).outer);
    expect(c).toEqual({ x: 500, y: 500 });
  });
});
