import { describe, it, expect } from 'vitest';
import type { Polygon, Layer } from '../../src/types';
import { runDrc } from '../../src/core/drc';

const apertureLayer: Layer = {
  name: '0', color: '#4a9eff', linetype: 'CONTINUOUS', lineweight: -1,
  visible: true, locked: false, plot: true, isAperture: true,
};

function rect(x1: number, y1: number, x2: number, y2: number, id = 'r'): Polygon {
  return {
    id,
    outer: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
    holes: [],
    layer: '0',
  };
}

function lShape(id = 'l'): Polygon {
  // L-shape: 300×300 bounding box, arm width = 100µm
  // bbox would pass 200µm aperture check; narrowest passage (100µm) should fail
  return {
    id,
    outer: [
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 },
      { x: 100, y: 100 }, { x: 100, y: 300 }, { x: 0, y: 300 },
    ],
    holes: [],
    layer: '0',
  };
}

// Explicit thresholds so tests are independent of DEFAULT_DRC_CONFIG changes
const cfg = { minApertureUm: 200, minSpacingUm: 150 };

describe('DRC aperture check', () => {
  it('passes for a rectangle larger than min aperture', () => {
    const errors = runDrc([rect(0, 0, 300, 300)], [apertureLayer], cfg);
    expect(errors.filter((e) => e.shapeId === 'r' && e.message.includes('Aperture'))).toHaveLength(0);
  });

  it('fails for a rectangle smaller than min aperture', () => {
    const errors = runDrc([rect(0, 0, 100, 500)], [apertureLayer], cfg);
    const apertureErrors = errors.filter((e) => e.message.includes('Aperture'));
    expect(apertureErrors.length).toBeGreaterThan(0);
    expect(apertureErrors[0].severity).toBe('error');
  });

  it('detects thin arm in L-shape that bbox would miss', () => {
    const errors = runDrc([lShape()], [apertureLayer], cfg);
    const apertureErrors = errors.filter((e) => e.message.includes('Aperture'));
    // bbox is 300×300 → old DRC would pass; new DRC detects 100µm arm
    expect(apertureErrors.length).toBeGreaterThan(0);
    expect(apertureErrors[0].severity).toBe('error');
  });

  it('includes loc in aperture error', () => {
    const errors = runDrc([rect(0, 0, 100, 500)], [apertureLayer], cfg);
    const apertureErrors = errors.filter((e) => e.message.includes('Aperture'));
    expect(apertureErrors[0].loc).toBeDefined();
  });
});

describe('DRC spacing check', () => {
  it('no error when shapes are far apart', () => {
    const errors = runDrc([rect(0, 0, 200, 200, 'a'), rect(400, 0, 600, 200, 'b')], [apertureLayer], cfg);
    expect(errors.filter((e) => e.message.includes('Spacing') || e.message.includes('overlap'))).toHaveLength(0);
  });

  it('warning when shapes are too close', () => {
    const errors = runDrc([rect(0, 0, 200, 200, 'a'), rect(300, 0, 500, 200, 'b')], [apertureLayer], cfg);
    // gap = 100µm < 150µm
    const spacingWarnings = errors.filter((e) => e.message.includes('Spacing'));
    expect(spacingWarnings.length).toBeGreaterThan(0);
    expect(spacingWarnings[0].severity).toBe('warning');
    expect(spacingWarnings[0].shapeId2).toBeDefined();
  });

  it('error when shapes overlap', () => {
    const errors = runDrc([rect(0, 0, 200, 200, 'a'), rect(100, 100, 300, 300, 'b')], [apertureLayer], cfg);
    const overlapErrors = errors.filter((e) => e.message.includes('overlap'));
    expect(overlapErrors.length).toBeGreaterThan(0);
    expect(overlapErrors[0].severity).toBe('error');
  });

  it('no false overlap for L-shape with rectangle in concave area', () => {
    // Rect B fits inside the concave cutout of L-shape A — bboxes overlap, geometry does not
    const a = lShape('a');
    const b = rect(110, 110, 290, 290, 'b');
    const errors = runDrc([a, b], [apertureLayer], cfg);
    const overlapErrors = errors.filter((e) => e.message.includes('overlap'));
    expect(overlapErrors).toHaveLength(0);
  });

  it('spacing error includes loc', () => {
    const errors = runDrc([rect(0, 0, 200, 200, 'a'), rect(300, 0, 500, 200, 'b')], [apertureLayer], cfg);
    const spacingErrors = errors.filter((e) => e.message.includes('Spacing'));
    expect(spacingErrors[0].loc).toBeDefined();
  });
});

describe('DRC edge cases', () => {
  it('empty shapes list returns no errors', () => {
    expect(runDrc([], [apertureLayer], cfg)).toHaveLength(0);
  });

  it('single shape with no aperture issues returns no errors', () => {
    expect(runDrc([rect(0, 0, 1000, 1000)], [apertureLayer], cfg)).toHaveLength(0);
  });

  it('caps errors at MAX_ERRORS (20)', () => {
    const shapes = Array.from({ length: 10 }, (_, i) =>
      rect(i * 50, 0, i * 50 + 40, 40, `s${i}`)  // tiny 40µm shapes, all close together
    );
    const errors = runDrc(shapes, [apertureLayer], cfg);
    expect(errors.length).toBeLessThanOrEqual(20);
  });
});
