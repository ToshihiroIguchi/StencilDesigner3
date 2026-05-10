import { describe, it, expect } from 'vitest';
import { exportDxf } from '../../src/dxf/exporter';
import { rectToPolygon } from '../../src/core/geometry';
import { defaultLayers } from '../../src/types';
import type { Layer } from '../../src/types';

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
    const dxf = exportDxf([outlineRect], layers, { aperturesOnly: false });
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
