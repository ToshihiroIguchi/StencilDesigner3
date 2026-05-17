import { describe, it, expect } from 'vitest';
import { findSnap } from '../../src/core/snap';
import { circleToPolygon, rectToPolygon } from '../../src/core/geometry';

describe('findSnap - circle center snap', () => {
  it('snaps to center of a circle when cursor is near center', () => {
    const c = circleToPolygon(0, 0, 1000);
    const result = findSnap({ x: 50, y: 50 }, [c], 100, 200);
    expect(result.kind).toBe('center');
    expect(Math.abs(result.point.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.point.y)).toBeLessThanOrEqual(1);
  });

  it('snaps to vertex over center when vertex is closer', () => {
    const c = circleToPolygon(0, 0, 1000);
    // cursor very close to the (1000, 0) vertex
    const result = findSnap({ x: 999, y: 0 }, [c], 100, 50);
    expect(result.kind).toBe('vertex');
    expect(result.point.x).toBeGreaterThan(900);
  });

  it('does NOT snap to center of a rectangle', () => {
    const r = rectToPolygon(0, 0, 1000, 1000);
    // cursor at bbox center (500, 500); snapRadius=50 so grid snap kicks in
    const result = findSnap({ x: 500, y: 500 }, [r], 100, 50);
    // grid snap to nearest 100µm grid: (500, 500) is on grid
    expect(result.kind).toBe('grid');
    expect(result.point).toEqual({ x: 500, y: 500 });
  });

  it('snaps to small circle center (radius 30µm)', () => {
    const c = circleToPolygon(0, 0, 30);
    const result = findSnap({ x: 5, y: 5 }, [c], 10, 20);
    expect(result.kind).toBe('center');
    expect(Math.abs(result.point.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.point.y)).toBeLessThanOrEqual(1);
  });

  it('excludes the shape being moved (excludeShapeId)', () => {
    const c = circleToPolygon(0, 0, 1000);
    // cursor near center but the shape is excluded (being dragged)
    const result = findSnap({ x: 50, y: 50 }, [c], 100, 200, c.id);
    // should fall through to grid snap (gridSize=100): Math.round(50/100)*100 = 100
    expect(result.kind).toBe('grid');
    expect(result.point).toEqual({ x: 100, y: 100 });
  });

  it('snaps to center of off-origin circle', () => {
    const c = circleToPolygon(5000, 3000, 500);
    const result = findSnap({ x: 5010, y: 3010 }, [c], 1000, 100);
    expect(result.kind).toBe('center');
    expect(Math.abs(result.point.x - 5000)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.point.y - 3000)).toBeLessThanOrEqual(1);
  });
});

describe('findSnap - edge snap (Tier 2)', () => {
  it('snaps to nearest point on edge when no vertex/midpoint nearby', () => {
    // Rect 0,0 → 1000,1000. Top edge y=0. Cursor at (300, -20) with snapRadius=50.
    // No vertex (nearest is at (0,0) dist≈360, too far) and no midpoint in range.
    // Edge nearest: (300, 0) at dist=20 < 50.
    const r = rectToPolygon(0, 0, 1000, 1000);
    const result = findSnap({ x: 300, y: -20 }, [r], 100, 50);
    expect(result.kind).toBe('edge');
    expect(result.point.y).toBe(0);
    expect(Math.abs(result.point.x - 300)).toBeLessThanOrEqual(1);
  });

  it('vertex wins over edge-nearest when vertex is within Tier 1', () => {
    const r = rectToPolygon(0, 0, 1000, 1000);
    // cursor very close to vertex (0,0)
    const result = findSnap({ x: 5, y: 5 }, [r], 100, 50);
    expect(result.kind).toBe('vertex');
    expect(result.point).toEqual({ x: 0, y: 0 });
  });

  it('midpoint wins over edge-nearest when midpoint is within Tier 1', () => {
    // Top edge midpoint is (500, 0). Cursor at (495, 3) — midpoint at dist≈6, within snapRadius=50.
    // Edge nearest would be (495, 0) at dist=3, but Tier 1 fires first and midpoint is captured.
    const r = rectToPolygon(0, 0, 1000, 1000);
    const result = findSnap({ x: 495, y: 3 }, [r], 100, 50);
    expect(result.kind).toBe('midpoint');
    expect(result.point).toEqual({ x: 500, y: 0 });
  });

  it('falls through to grid when edge is also out of range', () => {
    const r = rectToPolygon(0, 0, 1000, 1000);
    const result = findSnap({ x: 2000, y: 2000 }, [r], 100, 50);
    expect(result.kind).toBe('grid');
    expect(result.point).toEqual({ x: 2000, y: 2000 });
  });

  it('edge snap excludeShapeId is respected', () => {
    // cursor (305, -20), snapRadius=50. Edge of rect would give (305, 0) dist=20.
    // But shape is excluded → falls through to grid: round(305/100)*100=300, round(-20/100)*100=0.
    const r = rectToPolygon(0, 0, 1000, 1000);
    const result = findSnap({ x: 305, y: -20 }, [r], 100, 50, r.id);
    expect(result.kind).toBe('grid');
    expect(result.point.x).toBe(300);
    expect(result.point.y + 0).toBe(0); // +0 normalizes -0 to 0
  });

  it('edge ref contains correct shapeId, edgeStartId, edgeEndId and t', () => {
    const rect = rectToPolygon(0, 0, 1000, 1000);
    // cursor at (400, -20): snaps to (400, 0) on top edge
    const result = findSnap({ x: 400, y: -20 }, [rect], 100, 50);
    expect(result.kind).toBe('edge');
    expect(result.ref?.kind).toBe('edge');
    if (result.ref?.kind === 'edge') {
      expect(result.ref.shapeId).toBe(rect.id);
      expect(typeof result.ref.t).toBe('number');
      expect(result.ref.t).toBeGreaterThanOrEqual(0);
      expect(result.ref.t).toBeLessThanOrEqual(1);
    }
  });
});

describe('findSnap - SnapResult ref', () => {
  it('vertex ref contains vertexId', () => {
    const r = rectToPolygon(0, 0, 1000, 1000);
    const result = findSnap({ x: 2, y: 2 }, [r], 100, 50);
    expect(result.kind).toBe('vertex');
    expect(result.ref?.kind).toBe('vertex');
    if (result.ref?.kind === 'vertex') {
      expect(typeof result.ref.vertexId).toBe('string');
      expect(result.ref.vertexId.length).toBeGreaterThan(0);
    }
  });

  it('midpoint ref contains edgeStartId and edgeEndId', () => {
    const r = rectToPolygon(0, 0, 1000, 1000);
    // cursor near top-edge midpoint (500, 0)
    const result = findSnap({ x: 500, y: 2 }, [r], 100, 50);
    expect(result.kind).toBe('midpoint');
    expect(result.ref?.kind).toBe('midpoint');
    if (result.ref?.kind === 'midpoint') {
      expect(typeof result.ref.edgeStartId).toBe('string');
      expect(typeof result.ref.edgeEndId).toBe('string');
    }
  });

  it('grid snap has no ref', () => {
    const result = findSnap({ x: 550, y: 550 }, [], 100, 50);
    expect(result.kind).toBe('grid');
    expect(result.ref).toBeUndefined();
  });
});
