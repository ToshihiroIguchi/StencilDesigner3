import { describe, it, expect } from 'vitest';
import { findSnapPoint } from '../../src/core/selection';
import { circleToPolygon, rectToPolygon } from '../../src/core/geometry';

describe('findSnapPoint - circle center snap', () => {
  it('snaps to center of a circle when cursor is near center', () => {
    const c = circleToPolygon(0, 0, 1000);
    const result = findSnapPoint({ x: 50, y: 50 }, [c], 100, 200);
    expect(Math.abs(result.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y)).toBeLessThanOrEqual(1);
  });

  it('snaps to vertex over center when vertex is closer', () => {
    const c = circleToPolygon(0, 0, 1000);
    // cursor very close to the (1000, 0) vertex
    const result = findSnapPoint({ x: 999, y: 0 }, [c], 100, 50);
    expect(result.x).toBeGreaterThan(900);
  });

  it('does NOT snap to center of a rectangle', () => {
    const r = rectToPolygon(0, 0, 1000, 1000);
    // cursor at bbox center (500, 500); snapRadius=50 so grid snap kicks in
    const result = findSnapPoint({ x: 500, y: 500 }, [r], 100, 50);
    // grid snap to nearest 100µm grid: (500, 500) is on grid
    expect(result).toEqual({ x: 500, y: 500 });
    // Make sure it didn't snap to a vertex (nearest vertex is at distance 707µm >> 50)
    const dists = r.outer.map((p) => Math.sqrt((p.x - 500) ** 2 + (p.y - 500) ** 2));
    // All vertices are at ~707µm, well outside snapRadius=50
    expect(Math.min(...dists)).toBeGreaterThan(50);
  });

  it('snaps to small circle center (radius 30µm)', () => {
    const c = circleToPolygon(0, 0, 30);
    const result = findSnapPoint({ x: 5, y: 5 }, [c], 10, 20);
    expect(Math.abs(result.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y)).toBeLessThanOrEqual(1);
  });

  it('excludes the shape being moved (excludeShapeId)', () => {
    const c = circleToPolygon(0, 0, 1000);
    // cursor near center but the shape is excluded (being dragged)
    const result = findSnapPoint({ x: 50, y: 50 }, [c], 100, 200, c.id);
    // should fall through to grid snap (gridSize=100): Math.round(50/100)*100 = 100
    expect(result).toEqual({ x: 100, y: 100 });
  });

  it('snaps to center of off-origin circle', () => {
    const c = circleToPolygon(5000, 3000, 500);
    const result = findSnapPoint({ x: 5010, y: 3010 }, [c], 1000, 100);
    expect(Math.abs(result.x - 5000)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y - 3000)).toBeLessThanOrEqual(1);
  });
});
