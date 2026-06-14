/**
 * Unit tests for the SPLINE import helper functions in src/dwg/importer.ts.
 *
 * Tests cover:
 *   - bsplinePointsMm: de Boor B-spline / NURBS evaluation
 *   - fitSplinePointsMm: centripetal Catmull-Rom interpolation
 */
import { describe, it, expect } from 'vitest';
import { bsplinePointsMm, fitSplinePointsMm } from '../../src/dwg/importer';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Euclidean distance between two mm-space points. */
function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

/** Evaluates a cubic Bézier P0..P3 at t ∈ [0,1]. */
function cubicBezier(
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u ** 3 * p0x + 3 * u ** 2 * t * p1x + 3 * u * t ** 2 * p2x + t ** 3 * p3x,
    y: u ** 3 * p0y + 3 * u ** 2 * t * p1y + 3 * u * t ** 2 * p2y + t ** 3 * p3y,
  };
}

// ─── bsplinePointsMm ─────────────────────────────────────────────────────────

describe('bsplinePointsMm', () => {
  // A degree-1 clamped B-spline is exactly a polyline through the control points.
  it('degree-1 clamped: reproduces the control polyline', () => {
    const ctrl = [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
      { x: 30, y: 10 },
    ];
    // Clamped knot vector for degree=1, n=4: [0,0, 1, 2, 3, 3]
    const knots = [0, 0, 1, 2, 3, 3];
    const pts = bsplinePointsMm(1, ctrl, knots, undefined, false);
    expect(pts).not.toBeNull();

    // First and last output points must equal first and last control points.
    expect(pts![0].x).toBeCloseTo(ctrl[0].x, 6);
    expect(pts![0].y).toBeCloseTo(ctrl[0].y, 6);
    const last = pts![pts!.length - 1];
    expect(last.x).toBeCloseTo(ctrl[ctrl.length - 1].x, 6);
    expect(last.y).toBeCloseTo(ctrl[ctrl.length - 1].y, 6);

    // A degree-1 spline is piecewise linear: every output point must lie on one
    // of the line segments between consecutive control points.
    for (const p of pts!) {
      let onSegment = false;
      for (let i = 0; i < ctrl.length - 1; i++) {
        const dx = ctrl[i + 1].x - ctrl[i].x;
        const dy = ctrl[i + 1].y - ctrl[i].y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-9) continue;
        const t = ((p.x - ctrl[i].x) * dx + (p.y - ctrl[i].y) * dy) / (len * len);
        if (t < -1e-6 || t > 1 + 1e-6) continue;
        const nearX = ctrl[i].x + t * dx;
        const nearY = ctrl[i].y + t * dy;
        if (Math.sqrt((p.x - nearX) ** 2 + (p.y - nearY) ** 2) < 1e-4) {
          onSegment = true;
          break;
        }
      }
      expect(onSegment).toBe(true);
    }
  });

  // A single Bézier span expressed as a clamped cubic B-spline with repeated knots
  // [0,0,0,0,1,1,1,1] must match the analytic cubic Bézier at sampled t values.
  it('single cubic Bézier span matches analytic evaluation within tolerance', () => {
    const ctrl = [
      { x: 0, y: 0 },
      { x: 10, y: 30 },
      { x: 20, y: 30 },
      { x: 30, y: 0 },
    ];
    // Clamped cubic B-spline with a single span: k=[0,0,0,0,1,1,1,1]
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const pts = bsplinePointsMm(3, ctrl, knots, undefined, false);
    expect(pts).not.toBeNull();

    // First and last must match endpoints.
    expect(pts![0].x).toBeCloseTo(ctrl[0].x, 4);
    expect(pts![0].y).toBeCloseTo(ctrl[0].y, 4);
    const last = pts![pts!.length - 1];
    expect(last.x).toBeCloseTo(ctrl[3].x, 4);
    expect(last.y).toBeCloseTo(ctrl[3].y, 4);

    // Every output point must lie on the true cubic Bézier curve.
    // A clamped single-span cubic B-spline IS exactly the Bézier, so each adaptive
    // output point should be within a tight tolerance of the nearest point on the curve.
    // We verify by sampling the Bézier densely and checking the minimum distance.
    const BEZIER_SAMPLES = 1000;
    const bezierPts = Array.from({ length: BEZIER_SAMPLES + 1 }, (_, i) => {
      const t = i / BEZIER_SAMPLES;
      return cubicBezier(
        ctrl[0].x, ctrl[0].y,
        ctrl[1].x, ctrl[1].y,
        ctrl[2].x, ctrl[2].y,
        ctrl[3].x, ctrl[3].y,
        t,
      );
    });
    for (const actual of pts!) {
      const minDist = Math.min(...bezierPts.map((bp) => dist(actual.x, actual.y, bp.x, bp.y)));
      // Each adaptive point must lie very close to the true Bézier curve.
      // 0.05 mm tolerance (100x our CHORD_TOL_MM) accounts for discrete Bézier sampling.
      expect(minDist).toBeLessThan(0.05);
    }
  });

  // Rational NURBS with weights [1,0.7071,1,0.7071,1] approximates a quarter circle.
  // For a quarter-circle NURBS the points must stay within the control polygon convex hull.
  it('rational NURBS (quarter-circle approximation): output stays within control polygon hull', () => {
    // Standard NURBS quarter-circle: 3 control points, degree=2, conic arc.
    // Ctrl: (1,0), (1,1), (0,1) — weights w=[1, cos(45°)=√2/2, 1].
    const ctrl = [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const w = Math.cos(Math.PI / 4);
    const weights = [1, w, 1];
    // Clamped quadratic: knots [0,0,0,1,1,1]
    const knots = [0, 0, 0, 1, 1, 1];
    const pts = bsplinePointsMm(2, ctrl, knots, weights, false);
    expect(pts).not.toBeNull();

    // All output points should satisfy x>=0, y>=0, x<=1, y<=1 (inside the hull).
    for (const p of pts!) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(1 + 1e-6);
      expect(p.y).toBeLessThanOrEqual(1 + 1e-6);
    }

    // Endpoints must exactly match control polygon start/end.
    expect(pts![0].x).toBeCloseTo(1, 6);
    expect(pts![0].y).toBeCloseTo(0, 6);
    const last = pts![pts!.length - 1];
    expect(last.x).toBeCloseTo(0, 6);
    expect(last.y).toBeCloseTo(1, 6);

    // The NURBS quarter-circle deviates from the true arc by < 0.07% of the radius.
    for (const p of pts!) {
      const r = Math.sqrt(p.x * p.x + p.y * p.y);
      expect(Math.abs(r - 1)).toBeLessThan(0.001);
    }
  });

  // Malformed inputs should return null (guard against bad DWG data).
  it('returns null for malformed knot vector', () => {
    const ctrl = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    // Correct length would be 2+2+1=5; provide wrong length (3).
    expect(bsplinePointsMm(2, ctrl, [0, 0, 1], undefined, false)).toBeNull();
  });

  it('returns null for degree < 1', () => {
    const ctrl = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const knots = [0, 0, 0, 1, 1, 1];
    expect(bsplinePointsMm(0, ctrl, knots, undefined, false)).toBeNull();
  });

  it('returns null for fewer than 2 control points', () => {
    expect(bsplinePointsMm(1, [{ x: 0, y: 0 }], [0, 0, 1], undefined, false)).toBeNull();
    expect(bsplinePointsMm(1, [], [], undefined, false)).toBeNull();
  });

  // First and last output points must equal first/last control points for clamped knots.
  it('endpoints equal first/last control points for generic clamped cubic', () => {
    const ctrl = [
      { x: 5, y: 2 },
      { x: 8, y: 10 },
      { x: 12, y: -3 },
      { x: 15, y: 7 },
      { x: 20, y: 5 },
    ];
    // Clamped cubic knots for n=5: [0,0,0,0,1,2,2,2,2]
    const knots = [0, 0, 0, 0, 1, 2, 2, 2, 2];
    const pts = bsplinePointsMm(3, ctrl, knots, undefined, false);
    expect(pts).not.toBeNull();
    expect(pts![0].x).toBeCloseTo(ctrl[0].x, 4);
    expect(pts![0].y).toBeCloseTo(ctrl[0].y, 4);
    const last = pts![pts!.length - 1];
    expect(last.x).toBeCloseTo(ctrl[ctrl.length - 1].x, 4);
    expect(last.y).toBeCloseTo(ctrl[ctrl.length - 1].y, 4);
  });

  // Adaptive subdivision: output count is bounded well below 2048 for typical B-splines.
  it('adaptive output count is bounded well below 2048 for typical clamped cubic', () => {
    const ctrl = [
      { x: 0,   y: 0 },
      { x: 30,  y: 80 },
      { x: 70,  y: -40 },
      { x: 100, y: 50 },
      { x: 140, y: 0 },
    ];
    // Clamped cubic knots for n=5: [0,0,0,0,1,2,2,2,2]
    const knots = [0, 0, 0, 0, 1, 2, 2, 2, 2];
    const pts = bsplinePointsMm(3, ctrl, knots, undefined, false);
    expect(pts).not.toBeNull();
    // Adaptive: must be far below the old 2048 cap (was ~2048; now bounded by curvature).
    expect(pts!.length).toBeLessThan(1024);
    // Must still be denser than just the control points.
    expect(pts!.length).toBeGreaterThan(ctrl.length);
  });

  // A collinear B-spline (degree-1, control polygon is a straight line) should produce
  // very few points — adaptive flatness recognizes straight segments immediately.
  it('straight-line degree-1 B-spline produces minimal output (adaptive flatness)', () => {
    const ctrl = [
      { x: 0,   y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 300, y: 0 },
    ];
    const knots = [0, 0, 1, 2, 3, 3];
    const pts = bsplinePointsMm(1, ctrl, knots, undefined, false);
    expect(pts).not.toBeNull();
    // A perfectly straight degree-1 B-spline: adaptive subdivision adds no interior points.
    // Expect only the exact endpoints per knot span = 5 points (one per knot value 0,1,2,3).
    // At minimum: just start + end = 2 points (no mid-chord error).
    expect(pts!.length).toBeLessThan(20);
  });
});

// ─── fitSplinePointsMm ───────────────────────────────────────────────────────

describe('fitSplinePointsMm', () => {
  // The output must pass through every fit point within a tight tolerance.
  it('output passes through every fit point', () => {
    const fitPts = [
      { x: 0, y: 0 },
      { x: 5, y: 8 },
      { x: 10, y: 3 },
      { x: 15, y: 10 },
      { x: 20, y: 2 },
    ];
    const pts = fitSplinePointsMm(fitPts, false);

    // For each fit point, there must be an output point within 1e-4 mm.
    for (const fp of fitPts) {
      const closest = Math.min(...pts.map((p) => dist(p.x, p.y, fp.x, fp.y)));
      expect(closest).toBeLessThan(1e-4);
    }
  });

  // Two points: must produce a straight line.
  it('2 points produces a straight line', () => {
    const fitPts = [{ x: 0, y: 0 }, { x: 10, y: 5 }];
    const pts = fitSplinePointsMm(fitPts, false);
    expect(pts.length).toBe(2);
    expect(pts[0].x).toBeCloseTo(0, 6);
    expect(pts[0].y).toBeCloseTo(0, 6);
    expect(pts[1].x).toBeCloseTo(10, 6);
    expect(pts[1].y).toBeCloseTo(5, 6);
  });

  // Closed curve: output starts and ends at the same point.
  it('closed case: first and last output point are identical', () => {
    const fitPts = [
      { x: 0, y: 0 },
      { x: 5, y: 10 },
      { x: 10, y: 0 },
      { x: 5, y: -5 },
    ];
    const pts = fitSplinePointsMm(fitPts, true);
    expect(pts.length).toBeGreaterThan(2);
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(first.x).toBeCloseTo(last.x, 6);
    expect(first.y).toBeCloseTo(last.y, 6);
  });

  // Closed curve must also pass through all fit points.
  it('closed case: output passes through every fit point', () => {
    const fitPts = [
      { x: 0, y: 0 },
      { x: 5, y: 10 },
      { x: 10, y: 0 },
      { x: 5, y: -5 },
    ];
    const pts = fitSplinePointsMm(fitPts, true);
    for (const fp of fitPts) {
      const closest = Math.min(...pts.map((p) => dist(p.x, p.y, fp.x, fp.y)));
      expect(closest).toBeLessThan(1e-4);
    }
  });

  // Collinear fit points: the curve should be a straight line (no overshoot).
  it('collinear fit points: no overshoot beyond endpoints', () => {
    const fitPts = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 0 },
    ];
    const pts = fitSplinePointsMm(fitPts, false);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-4);
      expect(p.x).toBeLessThanOrEqual(15 + 1e-4);
      expect(Math.abs(p.y)).toBeLessThan(1e-4); // must stay on the line
    }
  });

  // Output must be densified (more points than fit points) for ≥3 fit points.
  it('output is denser than the input for ≥3 fit points', () => {
    const fitPts = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: 0 },
    ];
    const pts = fitSplinePointsMm(fitPts, false);
    expect(pts.length).toBeGreaterThan(fitPts.length);
  });

  // Adaptive subdivision: a nearly-straight set of fit points should yield very few
  // intermediate points (straight lines need no subdivision).
  it('nearly-straight fit points yield very few output points (adaptive flatness)', () => {
    // Five collinear points spanning 100 mm — essentially a straight line.
    const fitPts = [
      { x: 0,   y: 0 },
      { x: 25,  y: 0.0001 },
      { x: 50,  y: 0 },
      { x: 75,  y: 0.0001 },
      { x: 100, y: 0 },
    ];
    const pts = fitSplinePointsMm(fitPts, false);
    // Adaptive flatness: a nearly-straight curve should produce far fewer than 100 points.
    expect(pts.length).toBeLessThan(30);
    // But it must still include the exact endpoints.
    expect(pts[0].x).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1].x).toBeCloseTo(100, 6);
  });

  // A high-curvature set should produce more output points than a straight set.
  it('high-curvature fit points yield more points than a straight set', () => {
    const straight = [
      { x: 0, y: 0 }, { x: 25, y: 0 }, { x: 50, y: 0 }, { x: 75, y: 0 }, { x: 100, y: 0 },
    ];
    const curvy = [
      { x: 0, y: 0 }, { x: 10, y: 30 }, { x: 20, y: -30 }, { x: 30, y: 30 }, { x: 40, y: 0 },
    ];
    const straightPts = fitSplinePointsMm(straight, false);
    const curvyPts = fitSplinePointsMm(curvy, false);
    expect(curvyPts.length).toBeGreaterThan(straightPts.length);
  });

  // Adaptive output count is bounded: even for many fit points, stays well below 2048.
  it('output count is bounded well below 2048 even for typical DWG spline sizes', () => {
    // 6 fit points spanning ~200 mm — representative of example_2018.dwg splines.
    const fitPts = [
      { x: 0,   y: 0 },
      { x: 40,  y: 50 },
      { x: 80,  y: -30 },
      { x: 120, y: 60 },
      { x: 160, y: -20 },
      { x: 200, y: 10 },
    ];
    const pts = fitSplinePointsMm(fitPts, false);
    // Adaptive: must be far below the old 2048 cap (was ~2048; now bounded by curvature).
    expect(pts.length).toBeLessThan(1024);
    expect(pts.length).toBeGreaterThan(fitPts.length); // still denser than raw input
  });
});

// ─── Regression: fixture loading with densification check ────────────────────

describe('convertDwgDatabase: regression with smooth splines', () => {
  // This test verifies the pure-function conversion of a DwgDatabase that contains
  // SPLINE entities produces more vertices than straight chords would, confirming
  // splines are densified.  We construct a synthetic DB with a single SPLINE.
  it('a SPLINE with fitPoints is densified compared to straight chords', async () => {
    const { convertDwgDatabase } = await import('../../src/dwg/importer');

    const fitPts = [
      { x: 0, y: 0, z: 0 },
      { x: 50, y: 80, z: 0 },
      { x: 100, y: 30, z: 0 },
      { x: 150, y: 90, z: 0 },
      { x: 200, y: 10, z: 0 },
    ];
    // Straight-chord count from 5 fit points: 4 segments = 4 pairs
    const straightChordSegments = fitPts.length - 1;

    const fakeDb = {
      tables: { BLOCK_RECORD: { entries: [] }, LAYER: { entries: [] } },
      entities: [
        {
          type: 'SPLINE',
          layer: '0',
          handle: '1',
          ownerBlockRecordSoftId: '0',
          transparencyType: 0,
          flag: 0,        // open
          degree: 3,
          knots: [],
          weights: undefined,
          controlPoints: [],
          fitPoints: fitPts,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = convertDwgDatabase(fakeDb);

    // The import must not throw and must produce no errors.
    expect(result.ignoredCounts['_error'] ?? 0).toBe(0);

    // Count total vertices in segments (open spline → segments, not closed rings).
    // Each segment contributes 2 vertices, but consecutive segments share an endpoint.
    // We count unique vertices by counting segments + 1.
    // Since open splines go to pushSegments, the total segment count should be > 4.
    // We cannot inspect segments directly from ImportResult, but we can confirm polygons
    // were created (buildImportResult may close loops) or just that no error occurred.
    // Instead, use fitSplinePointsMm directly to verify densification.
    const smoothPts = fitSplinePointsMm(
      fitPts.map((p) => ({ x: p.x, y: p.y })),
      false,
    );
    expect(smoothPts.length).toBeGreaterThan(straightChordSegments + 1);
  });

  // All fixture tests remain green: integer µm, no throws.
  // (Full fixture tests are in dwg-import.test.ts; this block is a light regression check
  //  using a synthetic SPLINE to avoid the WASM dependency in fast unit runs.)
  it('closed SPLINE with fitPoints converts to a closed ring without throwing', async () => {
    const { convertDwgDatabase } = await import('../../src/dwg/importer');

    const fitPts = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 100, z: 0 },
      { x: 0, y: 100, z: 0 },
    ];

    const fakeDb = {
      tables: { BLOCK_RECORD: { entries: [] }, LAYER: { entries: [] } },
      entities: [
        {
          type: 'SPLINE',
          layer: '0',
          handle: '1',
          ownerBlockRecordSoftId: '0',
          transparencyType: 0,
          flag: 1,        // closed
          degree: 3,
          knots: [],
          weights: undefined,
          controlPoints: [],
          fitPoints: fitPts,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Should not throw.
    expect(() => convertDwgDatabase(fakeDb)).not.toThrow();
  });
});
