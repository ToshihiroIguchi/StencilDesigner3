import { describe, it, expect } from 'vitest';
import { cutPolygon } from '../../src/core/cut';
import { rectToPolygon, circleToPolygon } from '../../src/core/geometry';
import type { Polygon, Point } from '../../src/types';
import { newId } from '../../src/types';
import { vertex } from '../../src/core/vertex';
import { normalize } from '../../src/normalize';

function makePoly(pts: [number, number][], layer = '0'): Polygon {
  const outer = pts.map(([x, y]) => vertex(x, y));
  return normalize({ id: newId(), outer, holes: [], layer });
}

function totalArea(pieces: Polygon[]): number {
  let sum = 0;
  for (const p of pieces) {
    let a = 0;
    const n = p.outer.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += p.outer[i].x * p.outer[j].y - p.outer[j].x * p.outer[i].y;
    }
    sum += Math.abs(a) / 2;
    for (const h of p.holes) {
      const nh = h.length;
      let ha = 0;
      for (let i = 0; i < nh; i++) {
        const j = (i + 1) % nh;
        ha += h[i].x * h[j].y - h[j].x * h[i].y;
      }
      sum -= Math.abs(ha) / 2;
    }
  }
  return sum;
}

// ─── Convex rectangle ────────────────────────────────────────────────────────

describe('cutPolygon — convex rectangle', () => {
  const rect = rectToPolygon(0, 0, 10000, 6000);

  it('horizontal cut splits into top and bottom', () => {
    const result = cutPolygon(rect, { x: -1000, y: 3000 }, { x: 11000, y: 3000 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    // Each piece should be ~30 000 000 µm²; total = original area
    const orig = 10000 * 6000;
    expect(Math.abs(totalArea(result.pieces) - orig)).toBeLessThan(10);
  });

  it('vertical cut splits left and right', () => {
    const result = cutPolygon(rect, { x: 5000, y: -1000 }, { x: 5000, y: 7000 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    expect(Math.abs(totalArea(result.pieces) - 10000 * 6000)).toBeLessThan(10);
  });

  it('diagonal cut produces two pieces', () => {
    const result = cutPolygon(rect, { x: -500, y: -500 }, { x: 10500, y: 6500 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
  });

  it('line that misses the rect returns no-cross', () => {
    const result = cutPolygon(rect, { x: 12000, y: 0 }, { x: 12000, y: 6000 });
    expect(result.status).toBe('no-cross');
  });

  it('line with endpoint inside returns no-cross (finite-segment rule)', () => {
    // p2 is inside the rect → partial cut → no cut
    const result = cutPolygon(rect, { x: -500, y: 3000 }, { x: 5000, y: 3000 });
    expect(result.status).toBe('no-cross');
  });
});

// ─── Concave (L-shape) ───────────────────────────────────────────────────────

describe('cutPolygon — concave L-shape', () => {
  // L-shape: 10000×10000 with top-right 5000×5000 corner removed
  const lShape = makePoly([
    [0, 0], [10000, 0], [10000, 5000], [5000, 5000], [5000, 10000], [0, 10000],
  ]);

  it('horizontal cut across the full width', () => {
    const result = cutPolygon(lShape, { x: -500, y: 7000 }, { x: 10500, y: 7000 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    // Area of L-shape = 10000*10000 - 5000*5000 = 75 000 000
    expect(Math.abs(totalArea(result.pieces) - 75_000_000)).toBeLessThan(50);
  });

  it('vertical cut through only the lower arm', () => {
    // x=2500: runs through x=2500 from y=-1 to y=11000 — crosses both top and bottom of L
    const result = cutPolygon(lShape, { x: 2500, y: -500 }, { x: 2500, y: 10500 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    expect(Math.abs(totalArea(result.pieces) - 75_000_000)).toBeLessThan(50);
  });

  it('cut that only crosses one arm (not the other) — finite segment respected', () => {
    // A short segment that crosses only the right arm (x 5000-10000, y 0-5000)
    // from y=-500 to y=2500 at x between 5000 and 10000 → crosses top+bottom of that arm
    const result = cutPolygon(lShape, { x: 7500, y: -500 }, { x: 7500, y: 5500 });
    // This crosses the right arm boundary at y=0 and y=5000 → should cut
    expect(result.status).toBe('cut');
  });
});

// ─── Segment that crosses concave shape twice (U-shape) ──────────────────────

describe('cutPolygon — U-shape (segment crosses twice)', () => {
  // U-shape: outer 10000×10000, with a 6000×6000 hole cut from the top leaving two arms
  // Vertices (CCW): bottom then right arm then across top then left arm
  const uShape = makePoly([
    [0, 0], [10000, 0], [10000, 10000], [7000, 10000],
    [7000, 4000], [3000, 4000], [3000, 10000], [0, 10000],
  ]);

  it('horizontal segment crossing both arms produces 3 pieces', () => {
    // A horizontal cut at y=7000 crosses left arm and right arm (two separate chords)
    const result = cutPolygon(uShape, { x: -500, y: 7000 }, { x: 10500, y: 7000 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    // 2 chords → 3 pieces (top-left, top-right, bottom)
    expect(result.pieces).toHaveLength(3);
  });
});

// ─── Polygon with hole ────────────────────────────────────────────────────────

describe('cutPolygon — polygon with a hole', () => {
  // Annular shape: 10000×10000 outer, 4000×4000 centered hole
  const outer = rectToPolygon(0, 0, 10000, 10000);
  const holePts: [number, number][] = [[3000, 3000], [7000, 3000], [7000, 7000], [3000, 7000]];
  const holeRing = holePts.map(([x, y]) => vertex(x, y));
  const withHole: Polygon = normalize({
    id: newId(),
    outer: outer.outer,
    holes: [holeRing],
    layer: '0',
  });

  it('cut that avoids the hole splits into two pieces', () => {
    // Horizontal cut at y=1500 — below the hole, cuts only the lower strip
    const result = cutPolygon(withHole, { x: -500, y: 1500 }, { x: 10500, y: 1500 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    // Hole should be assigned to the larger upper piece
    const piecesWithHole = result.pieces.filter((p) => p.holes.length > 0);
    expect(piecesWithHole).toHaveLength(1);
  });
});

// ─── Cut collinear with a non-overlapping edge ───────────────────────────────

describe('cutPolygon — cut collinear with a distant edge', () => {
  // L-shape: 10000×10000 with top-right 5000×5000 corner removed.
  // Its inner corner is at (5000, 5000); the vertical edge x=5000 spans y 5000–10000
  // and the horizontal edge y=5000 spans x 5000–10000.
  const lShape = makePoly([
    [0, 0], [10000, 0], [10000, 5000], [5000, 5000], [5000, 10000], [0, 10000],
  ]);

  it('vertical cut along the inner-corner line splits the lower slab', () => {
    // x=5000 from below the shape up to exactly the inner corner: collinear with
    // the x=5000 edge but only touching it at one point → must cut, not degenerate.
    const result = cutPolygon(lShape, { x: 5000, y: -500 }, { x: 5000, y: 5000 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    expect(Math.abs(totalArea(result.pieces) - 75_000_000)).toBeLessThan(50);
  });

  it('horizontal cut along the inner-corner line splits the left arm', () => {
    const result = cutPolygon(lShape, { x: -500, y: 5000 }, { x: 5000, y: 5000 });
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') return;
    expect(result.pieces).toHaveLength(2);
    expect(Math.abs(totalArea(result.pieces) - 75_000_000)).toBeLessThan(50);
  });
});

// ─── Degenerate cases ─────────────────────────────────────────────────────────

describe('cutPolygon — degenerate cases', () => {
  const rect = rectToPolygon(0, 0, 10000, 6000);

  it('line along an edge returns degenerate', () => {
    // Cut along the bottom edge y=0
    const result = cutPolygon(rect, { x: -500, y: 0 }, { x: 10500, y: 0 });
    expect(result.status).toBe('degenerate');
  });

  it('line partially overlapping an edge returns degenerate', () => {
    // Overlaps the bottom edge y=0 over x 0–5000
    const result = cutPolygon(rect, { x: -500, y: 0 }, { x: 5000, y: 0 });
    expect(result.status).toBe('degenerate');
  });

  it('zero-length cut returns no-cross', () => {
    const result = cutPolygon(rect, { x: 5000, y: 3000 }, { x: 5000, y: 3000 });
    expect(result.status).toBe('no-cross');
  });
});
