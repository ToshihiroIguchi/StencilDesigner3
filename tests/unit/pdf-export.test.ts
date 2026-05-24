import { describe, it, expect } from 'vitest';
import {
  computeBBox, pickOrientation, formatScaleRatio,
  pickScaleBarWorldMm, formatBarLabel,
  buildPdf,
} from '../../src/pdf/exporter';
import type { AppState, Polygon, Layer, Dimension } from '../../src/types';
import { createDefaultState } from '../../src/types';

const mkLayer = (name: string, visible = true): Layer => ({
  name,
  color: '#4a9eff',
  linetype: 'CONTINUOUS',
  lineweight: -1,
  visible,
  locked: false,
  plot: true,
  isAperture: true,
});

const mkRectShape = (id: string, x: number, y: number, w: number, h: number, layer = '0'): Polygon => ({
  id,
  layer,
  outer: [
    { id: `${id}_v0`, x, y },
    { id: `${id}_v1`, x: x + w, y },
    { id: `${id}_v2`, x: x + w, y: y + h },
    { id: `${id}_v3`, x, y: y + h },
  ],
  holes: [],
});

const mkLinearHDim = (id: string, x1: number, x2: number, y: number, offset: number): Dimension => ({
  id,
  kind: 'linear-h',
  anchor1: { kind: 'free', point: { x: x1, y } },
  anchor2: { kind: 'free', point: { x: x2, y } },
  offset,
  layer: 'DIMENSIONS',
  frozen: false,
});

const mkLinearVDim = (id: string, y1: number, y2: number, x: number, offset: number): Dimension => ({
  id,
  kind: 'linear-v',
  anchor1: { kind: 'free', point: { x, y: y1 } },
  anchor2: { kind: 'free', point: { x, y: y2 } },
  offset,
  layer: 'DIMENSIONS',
  frozen: false,
});

describe('computeBBox', () => {
  it('returns null when no visible shapes', () => {
    expect(computeBBox([], [], [mkLayer('0')])).toBeNull();
  });

  it('includes linear-h dim line offset in bbox', () => {
    const layers = [mkLayer('0'), mkLayer('DIMENSIONS')];
    const shapes = [mkRectShape('s1', 0, 0, 10000, 5000)];
    const dims: Dimension[] = [mkLinearHDim('d1', 0, 10000, 0, 8000)]; // dim line at Y=8000 (outside shape)
    const bbox = computeBBox(shapes, dims, layers);
    expect(bbox!.maxY).toBeGreaterThanOrEqual(8000);
  });

  it('includes linear-v dim line offset in bbox', () => {
    const layers = [mkLayer('0'), mkLayer('DIMENSIONS')];
    const shapes = [mkRectShape('s1', 0, 0, 10000, 5000)];
    const dims: Dimension[] = [mkLinearVDim('d2', 0, 5000, 0, 13000)]; // dim line at X=13000 (outside shape)
    const bbox = computeBBox(shapes, dims, layers);
    expect(bbox!.maxX).toBeGreaterThanOrEqual(13000);
  });

  it('ignores hidden-layer shapes', () => {
    const layers = [mkLayer('0', false)];
    const shapes = [mkRectShape('s1', 0, 0, 1000, 1000)];
    expect(computeBBox(shapes, [], layers)).toBeNull();
  });

  it('covers outer and holes (with padding)', () => {
    const layers = [mkLayer('0')];
    const shape: Polygon = {
      id: 's1',
      layer: '0',
      outer: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 10000, y: 0 },
        { id: 'c', x: 10000, y: 5000 },
        { id: 'd', x: 0, y: 5000 },
      ],
      holes: [
        [
          { id: 'h1', x: 1000, y: 1000 },
          { id: 'h2', x: 2000, y: 1000 },
          { id: 'h3', x: 2000, y: 2000 },
          { id: 'h4', x: 1000, y: 2000 },
        ],
      ],
    };
    const bbox = computeBBox([shape], [], layers);
    // Tight bounds are 0..10000 x 0..5000; bbox adds 8% padding each side
    expect(bbox).not.toBeNull();
    expect(bbox!.minX).toBeLessThanOrEqual(0);
    expect(bbox!.minY).toBeLessThanOrEqual(0);
    expect(bbox!.maxX).toBeGreaterThanOrEqual(10000);
    expect(bbox!.maxY).toBeGreaterThanOrEqual(5000);
  });
});

describe('pickOrientation', () => {
  it('picks landscape for wide bbox', () => {
    const bbox = { minX: 0, minY: 0, maxX: 200_000, maxY: 50_000 };
    expect(pickOrientation(bbox)).toBe('landscape');
  });

  it('picks portrait for tall bbox', () => {
    const bbox = { minX: 0, minY: 0, maxX: 50_000, maxY: 200_000 };
    expect(pickOrientation(bbox)).toBe('portrait');
  });
});

describe('formatScaleRatio', () => {
  it('1.0 → "1.0:1"', () => {
    expect(formatScaleRatio(1.0)).toBe('1.0:1');
  });

  it('0.2 → "1:5.0"', () => {
    expect(formatScaleRatio(0.2)).toBe('1:5.0');
  });

  it('2.0 → "2.0:1"', () => {
    expect(formatScaleRatio(2.0)).toBe('2.0:1');
  });

  it('0.05 → "1:20"', () => {
    expect(formatScaleRatio(0.05)).toBe('1:20');
  });
});

describe('pickScaleBarWorldMm', () => {
  it('returns 20 for scale 1.0 (targetWorld=30 → 20)', () => {
    expect(pickScaleBarWorldMm(1.0)).toBe(20);
  });

  it('returns 0.05 for scale 329 (sub-mm range)', () => {
    // targetWorld = 30/329 ≈ 0.091 → max nice ≤ 0.091 → 0.05
    expect(pickScaleBarWorldMm(329)).toBe(0.05);
  });

  it('returns 1 for scale ~30', () => {
    // targetWorld = 30/30 = 1.0 → max nice ≤ 1.0 → 1
    expect(pickScaleBarWorldMm(30)).toBe(1);
  });

  it('caps at 1000 for very small scale', () => {
    // targetWorld = 30/0.001 = 30000 → max nice ≤ 30000 → 1000
    expect(pickScaleBarWorldMm(0.001)).toBe(1000);
  });
});

describe('formatBarLabel', () => {
  it('mm mode: integer ≥ 1mm', () => {
    expect(formatBarLabel(1, 'mm')).toBe('1 mm');
    expect(formatBarLabel(20, 'mm')).toBe('20 mm');
  });

  it('mm mode: 2 decimals for sub-mm', () => {
    expect(formatBarLabel(0.05, 'mm')).toBe('0.05 mm');
    expect(formatBarLabel(0.5, 'mm')).toBe('0.50 mm');
  });

  it('um mode: always µm integer', () => {
    expect(formatBarLabel(0.05, 'um')).toBe('50 µm');
    expect(formatBarLabel(1, 'um')).toBe('1000 µm');
    expect(formatBarLabel(20, 'um')).toBe('20000 µm');
  });
});

describe('buildPdf', () => {
  it('returns null for empty state', async () => {
    const state: AppState = createDefaultState();
    expect(await buildPdf(state, 'Test')).toBeNull();
  });

  it('returns jsPDF with %PDF- header for non-empty state', async () => {
    const state: AppState = {
      ...createDefaultState(),
      shapes: [mkRectShape('s1', 0, 0, 10000, 10000)],
      layers: [mkLayer('0')],
    };
    const pdf = await buildPdf(state, 'Test');
    expect(pdf).not.toBeNull();
    const bytes = pdf!.output('arraybuffer') as ArrayBuffer;
    const header = new TextDecoder().decode(new Uint8Array(bytes).slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('produces valid PDF for multiple visible layers', async () => {
    const state: AppState = {
      ...createDefaultState(),
      shapes: [
        mkRectShape('s1', 0, 0, 10000, 10000, '0'),
        mkRectShape('s2', 15000, 0, 10000, 10000, 'OUTLINE'),
      ],
      layers: [mkLayer('0'), mkLayer('OUTLINE')],
    };
    expect(await buildPdf(state, 'MultiLayer')).not.toBeNull();
  });

  it('renders linear-h dimension without crash (offset fix)', async () => {
    const state: AppState = {
      ...createDefaultState(),
      shapes: [mkRectShape('s1', 0, 0, 10000, 10000)],
      dimensions: [mkLinearHDim('d1', 0, 10000, 0, -5000)],
      layers: [mkLayer('0'), mkLayer('DIMENSIONS')],
    };
    expect(await buildPdf(state, 'DimH')).not.toBeNull();
  });

  it('renders linear-v dimension without crash (offset fix)', async () => {
    const state: AppState = {
      ...createDefaultState(),
      shapes: [mkRectShape('s1', 0, 0, 10000, 10000)],
      dimensions: [mkLinearVDim('d2', 0, 10000, 0, 15000)],
      layers: [mkLayer('0'), mkLayer('DIMENSIONS')],
    };
    expect(await buildPdf(state, 'DimV')).not.toBeNull();
  });

  it('respects displayUnit=um for scale bar (µm mode)', async () => {
    const state: AppState = {
      ...createDefaultState(),
      shapes: [mkRectShape('s1', 0, 0, 760, 560)], // sub-mm shape
      layers: [mkLayer('0')],
      displayUnit: 'um',
    };
    // Should not throw even with very large scale factor
    expect(await buildPdf(state, 'UmMode')).not.toBeNull();
  });
});
