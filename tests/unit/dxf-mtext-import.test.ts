import { describe, it, expect } from 'vitest';
import { importDxf } from '../../src/dxf/importer';
import { exportDxf } from '../../src/dxf/exporter';
import { decodeMtext } from '../../src/dxf/mtext';
import { defaultLayers } from '../../src/types';
import type { Annotation, Dimension } from '../../src/types';

function wrap(entities: string): string {
  return ['0\nSECTION\n2\nHEADER', '9\n$ACADVER\n1\nAC1015', '0\nENDSEC', '0\nSECTION\n2\nENTITIES', entities, '0\nENDSEC', '0\nEOF'].join('\n');
}

describe('decodeMtext', () => {
  it('decodes line breaks, escapes and unicode', () => {
    expect(decodeMtext('A\\PB')).toBe('A\nB');
    expect(decodeMtext('\\{x\\}\\\\')).toBe('{x}\\');
    expect(decodeMtext('\\U+00B5m')).toBe('\u00B5m');
  });
  it('strips formatting codes and decodes %% codes', () => {
    expect(decodeMtext('{\\fArial|b0|i0;\\H2.5;Hello}')).toBe('Hello');
    expect(decodeMtext('%%c5 %%d')).toBe('\u23005 \u00B0');
  });
});

describe('DXF MTEXT / TEXT import', () => {
  it('imports MTEXT as an annotation with integer um coordinates', async () => {
    const dxf = wrap('0\nMTEXT\n8\nNOTES\n10\n1.2345\n20\n2.5\n30\n0\n40\n3\n71\n1\n1\n{\\fArial|b0;Line1}\\PLine2');
    const r = await importDxf(dxf);
    expect(r.annotations).toHaveLength(1);
    const a = r.annotations![0];
    expect(a.text).toBe('Line1\nLine2');
    expect(a.origin).toEqual({ x: 1235, y: -2500 });
    expect(a.heightUm).toBe(3000);
    expect(a.layer).toBe('NOTES');
  });

  it('imports TEXT entities', async () => {
    const dxf = wrap('0\nTEXT\n8\n0\n10\n1\n20\n1\n40\n2\n1\nD=%%c5');
    const r = await importDxf(dxf);
    expect(r.annotations![0].text).toBe('D=\u23005');
    expect(r.ignoredCounts['TEXT']).toBeUndefined();
  });

  it('round-trips an annotation and skips dimension labels', async () => {
    const ann: Annotation = { id: 'a1', text: 'Hello {x}\nSecond \u00B5m', origin: { x: 10000, y: -20000 }, heightUm: 5000, layer: 'DIMENSIONS' };
    const dim: Dimension = {
      id: 'd1', kind: 'linear-h', layer: 'DIMENSIONS', offset: 3000, frozen: false,
      anchor1: { kind: 'free', point: { x: 0, y: 0 } },
      anchor2: { kind: 'free', point: { x: 5000, y: 0 } },
    };
    const out = exportDxf([], defaultLayers(), [ann], [dim]);
    const r = await importDxf(out);
    expect(r.annotations).toHaveLength(1);
    const back = r.annotations![0];
    expect(back.text).toBe(ann.text);
    expect(back.origin).toEqual(ann.origin);
    expect(back.heightUm).toBe(ann.heightUm);
    expect(back.layer).toBe('DIMENSIONS');
  });
});
