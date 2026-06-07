import { describe, it, expect } from 'vitest';
import { exportDxf } from '../../src/dxf/exporter';
import { rectToPolygon } from '../../src/core/geometry';
import { defaultLayers, DIMENSIONS_LAYER } from '../../src/types';
import type { Annotation, Layer } from '../../src/types';

const layers = defaultLayers();
const apertureLayer = layers.find((l) => l.isAperture && l.name === '0')!;
const outlineLayer = layers.find((l) => l.name === 'OUTLINE')!;

describe('exportDxf — structure', () => {
  it('output starts with HEADER and ends with EOF', () => {
    const dxf = exportDxf([], layers);
    expect(dxf).toContain('0\nSECTION\n2\nHEADER');
    expect(dxf).toContain('0\nENDSEC');
    expect(dxf.trimEnd().endsWith('0\nEOF')).toBe(true);
  });

  it('ENTITIES section is present', () => {
    const dxf = exportDxf([], layers);
    expect(dxf).toContain('0\nSECTION\n2\nENTITIES');
  });

  it('LAYER table lists all layers', () => {
    const dxf = exportDxf([], layers);
    for (const l of layers) {
      expect(dxf).toContain(`2\n${l.name}`);
    }
  });
});

describe('exportDxf — aperture filtering', () => {
  const rect = rectToPolygon(0, 0, 2000, 1000, '0'); // aperture layer
  const outlineRect = rectToPolygon(0, 0, 2000, 1000, 'OUTLINE'); // non-aperture

  it('exports aperture polygon by default (aperturesOnly=true)', () => {
    const dxf = exportDxf([rect], layers);
    expect(dxf).toContain('0\nLWPOLYLINE');
    expect(dxf).toContain(`8\n${rect.layer}`);
  });

  it('skips non-aperture polygon when aperturesOnly=true', () => {
    const dxf = exportDxf([outlineRect], layers);
    expect(dxf).not.toContain('0\nLWPOLYLINE');
  });

  it('exports non-aperture polygon when aperturesOnly=false', () => {
    const dxf = exportDxf([outlineRect], layers, [], { aperturesOnly: false });
    expect(dxf).toContain('0\nLWPOLYLINE');
    expect(dxf).toContain(`8\nOUTLINE`);
  });
});

describe('exportDxf — coordinate conversion', () => {
  it('converts µm to mm and negates Y (2000µm x, 1000µm y → 2.000000mm, -1.000000mm)', () => {
    const rect = rectToPolygon(0, 0, 2000, 1000, '0');
    const dxf = exportDxf([rect], layers);
    expect(dxf).toContain('10\n2.000000');
    expect(dxf).toContain('20\n-1.000000');
  });

  it('rect is closed (flag 70 = 1)', () => {
    const rect = rectToPolygon(0, 0, 2000, 1000, '0');
    const dxf = exportDxf([rect], layers);
    expect(dxf).toContain('70\n1');
  });

  it('vertex count matches polygon outer ring', () => {
    const rect = rectToPolygon(0, 0, 2000, 1000, '0');
    const dxf = exportDxf([rect], layers);
    expect(dxf).toContain(`90\n${rect.outer.length}`);
  });
});

describe('exportDxf — annotations (MTEXT)', () => {
  const layersWithDim = [...defaultLayers(), { ...DIMENSIONS_LAYER }];

  function makeAnn(text: string, visible = true): Annotation {
    const layers = layersWithDim.map((l) =>
      l.name === 'DIMENSIONS' ? { ...l, visible } : l
    );
    void layers; // layers visibility is driven by the layer table passed to exportDxf
    return { id: 'a1', text, origin: { x: 5000, y: 3000 }, heightUm: 2000, layer: 'DIMENSIONS' };
  }

  it('emits MTEXT entity for an annotation', () => {
    const ann = makeAnn('Hello');
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).toContain('0\nMTEXT');
    expect(dxf).toContain('8\nDIMENSIONS');
  });

  it('converts origin: x µm→mm, y negated µm→mm', () => {
    const ann = makeAnn('test');
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).toContain('10\n5.000000');
    expect(dxf).toContain('20\n-3.000000');
  });

  it('converts heightUm to mm', () => {
    const ann = makeAnn('test');
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).toContain('40\n2.000000');
  });

  it('encodes newline as \\P', () => {
    const ann = makeAnn('line1\nline2');
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).toContain('line1\\Pline2');
  });

  it('escapes backslash, braces', () => {
    const ann = makeAnn('a\\b{c}');
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).toContain('a\\\\b\\{c\\}');
  });

  it('encodes non-ASCII (Japanese) as \\U+XXXX', () => {
    const ann = makeAnn('テスト'); // テ=30C6 ス=30B9 ト=30C8
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).toContain('\\U+30C6\\U+30B9\\U+30C8');
  });

  it('skips annotation on invisible layer', () => {
    const ann = makeAnn('hidden');
    const hiddenLayers = layersWithDim.map((l) =>
      l.name === 'DIMENSIONS' ? { ...l, visible: false } : l
    );
    const dxf = exportDxf([], hiddenLayers, [ann]);
    expect(dxf).not.toContain('0\nMTEXT');
  });

  it('skips empty/whitespace annotation', () => {
    const ann = makeAnn('   ');
    const dxf = exportDxf([], layersWithDim, [ann]);
    expect(dxf).not.toContain('0\nMTEXT');
  });

  it('omits MTEXT when includeAnnotations=false', () => {
    const ann = makeAnn('note');
    const dxf = exportDxf([], layersWithDim, [ann], { includeAnnotations: false });
    expect(dxf).not.toContain('0\nMTEXT');
  });
});

describe('exportDxf — holes', () => {
  it('hole is exported as a separate LWPOLYLINE', () => {
    const outer = rectToPolygon(0, 0, 4000, 4000, '0');
    // Manually add a hole (CW ring) — use inner rect vertices
    const innerRect = rectToPolygon(1000, 1000, 3000, 3000, '0');
    const polyWithHole = { ...outer, holes: [innerRect.outer] };

    const dxf = exportDxf([polyWithHole], layers);
    // Count LWPOLYLINE occurrences (outer + 1 hole)
    const count = (dxf.match(/0\nLWPOLYLINE/g) ?? []).length;
    expect(count).toBe(2);
  });
});

describe('exportDxf — ACI color mapping', () => {
  it('maps custom colors to closest standard ACI index', () => {
    const customLayers: Layer[] = [
      { name: 'RedLayer', color: '#ff1010', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: true },
      { name: 'BlueLayer', color: '#0505fa', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: true },
      { name: 'InvisibleGreen', color: '#10ef10', linetype: 'CONTINUOUS', lineweight: -1, visible: false, locked: false, plot: true, isAperture: true },
    ];
    const dxf = exportDxf([], customLayers);

    const redIdx = dxf.indexOf('2\nRedLayer');
    expect(redIdx).toBeGreaterThan(-1);
    const redAciSection = dxf.slice(redIdx, redIdx + 200);
    expect(redAciSection).toContain('62\n1');

    const blueIdx = dxf.indexOf('2\nBlueLayer');
    expect(blueIdx).toBeGreaterThan(-1);
    const blueAciSection = dxf.slice(blueIdx, blueIdx + 200);
    expect(blueAciSection).toContain('62\n5');

    const greenIdx = dxf.indexOf('2\nInvisibleGreen');
    expect(greenIdx).toBeGreaterThan(-1);
    const greenAciSection = dxf.slice(greenIdx, greenIdx + 200);
    expect(greenAciSection).toContain('62\n-3');
  });
});
