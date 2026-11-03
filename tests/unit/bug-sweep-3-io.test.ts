import { describe, it, expect, vi } from 'vitest';
import { importDxf } from '../../src/dxf/importer';
import { exportDxf } from '../../src/dxf/exporter';
import { findUnsupportedPdfChars } from '../../src/pdf/exporter';
import { cutPolygon } from '../../src/core/cut';
import { polygonArea, rectToPolygon } from '../../src/core/geometry';
import { pointInRing } from '../../src/normalize';
import { defaultLayers } from '../../src/types';
import type { Annotation, Dimension, Polygon } from '../../src/types';

function wrap(entities: string): string {
  return ['0\nSECTION\n2\nHEADER', '9\n$ACADVER\n1\nAC1015', '0\nENDSEC', '0\nSECTION\n2\nENTITIES', entities, '0\nENDSEC', '0\nEOF'].join('\n');
}

describe('B5 findUnsupportedPdfChars', () => {
  it('accepts Latin, kana, CJK ideographs and fullwidth forms', () => {
    expect(findUnsupportedPdfChars(['Hello 123 µm ±°', 'ひらがなカタカナ漢字', 'ＡＢＣ'])).toEqual([]);
  });
  it('reports emoji and astral-plane characters once each', () => {
    const r = findUnsupportedPdfChars(['ok \u{1F600} \u{1F600}', 'x \u{20BB7}']);
    expect(r).toContain('\u{1F600}');
    expect(r).toContain('\u{20BB7}');
    expect(r.filter((c) => c === '\u{1F600}')).toHaveLength(1);
  });
});

describe('B6 MTEXT attachment points', () => {
  // height 10 mm, text "ABCD" (4 chars) -> width 4*0.6*10 = 24 mm, em box height 1 line * 1.0 * 10 = 10 mm
  const W = 24000, H = 10000;
  const cases: Array<[number, number, number]> = [
    // attachment, expected dx (from insertion to top-left), expected dy (Y-down)
    [1, 0, 0], [2, -W / 2, 0], [3, -W, 0],
    [4, 0, -H / 2], [5, -W / 2, -H / 2], [6, -W, -H / 2],
    [7, 0, -H], [8, -W / 2, -H], [9, -W, -H],
  ];
  for (const [att, dx, dy] of cases) {
    it(`attachment point ${att}`, async () => {
      const dxf = wrap(`0\nMTEXT\n8\nNOTES\n10\n100\n20\n50\n30\n0\n40\n10\n71\n${att}\n1\nABCD`);
      const r = await importDxf(dxf);
      const a = r.annotations![0];
      expect(a.origin).toEqual({ x: 100000 + dx, y: -50000 + dy });
    });
  }

  it('warns when MTEXT rotation is non-zero', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dxf = wrap('0\nMTEXT\n8\nNOTES\n10\n0\n20\n0\n40\n10\n71\n1\n50\n30\n1\nABCD');
    await importDxf(dxf);
    expect(spy.mock.calls.some((c) => String(c[0]).toLowerCase().includes('rotation'))).toBe(true);
    spy.mockRestore();
  });

  it('TEXT with centered halign uses the alignment point', async () => {
    // halign 1 (center), valign 3 (top): alignment point (11,21) is the top-center
    const dxf = wrap('0\nTEXT\n8\n0\n10\n0\n20\n0\n40\n10\n1\nABCD\n72\n1\n73\n3\n11\n100\n21\n50');
    const r = await importDxf(dxf);
    expect(r.annotations![0].origin).toEqual({ x: 100000 - W / 2, y: -50000 });
  });
});

describe('TEXT vertical alignment', () => {
  const text = (v73: number) =>
    wrap(`0
TEXT
8
0
10
0
20
0
40
10
1
ABCD
72
0
73
${v73}
11
0
21
0`);
  it('baseline anchor puts the annotation origin one ascent (0.88 em) above the baseline', async () => {
    const r = await importDxf(text(0));
    expect(r.annotations![0].origin).toEqual({ x: 0, y: -8800 });
  });
  it('bottom anchor puts the origin one em-box (1.0 em) above the anchor', async () => {
    const r = await importDxf(text(1));
    expect(r.annotations![0].origin).toEqual({ x: 0, y: -10000 });
  });
  it('middle anchor puts the origin half an em-box above the anchor', async () => {
    const r = await importDxf(text(2));
    expect(r.annotations![0].origin).toEqual({ x: 0, y: -5000 });
  });
});

describe('B7 regression tests', () => {
  it('cut of a polygon with a hole keeps each hole in exactly one outer and conserves area', () => {
    const base = rectToPolygon(0, 0, 100000, 60000);
    const hole = [
      { id: 'h1', x: 20000, y: 20000 }, { id: 'h2', x: 20000, y: 40000 },
      { id: 'h3', x: 40000, y: 40000 }, { id: 'h4', x: 40000, y: 20000 },
    ];
    const poly: Polygon = { ...base, holes: [hole] };
    const total = polygonArea(poly);
    for (const [p1, p2] of [
      [{ x: 30000, y: -10000 }, { x: 30000, y: 70000 }], // through the hole
      [{ x: 70000, y: -10000 }, { x: 70000, y: 70000 }], // beside the hole
      [{ x: -10000, y: 10000 }, { x: 110000, y: 50000 }], // diagonal
    ]) {
      const res = cutPolygon(poly, p1, p2);
      expect(res.status).toBe('cut');
      if (res.status !== 'cut') continue;
      let sum = 0;
      for (const piece of res.pieces) sum += polygonArea(piece);
      expect(sum).toBe(total);
      for (const piece of res.pieces) {
        for (const h of piece.holes) {
          const c = {
            id: 'c',
            x: Math.round(h.reduce((n, q) => n + q.x, 0) / h.length),
            y: Math.round(h.reduce((n, q) => n + q.y, 0) / h.length),
          };
          const containing = res.pieces.filter((q) => pointInRing(c, q.outer));
          expect(containing).toHaveLength(1);
          expect(containing[0]).toBe(piece);
        }
      }
    }
  });

  it('DXF round trip with dimensions does not create extra polygons', async () => {
    const rect = rectToPolygon(0, 0, 10000, 5000, '0');
    const dims: Dimension[] = [
      {
        id: 'd1', kind: 'linear-h', layer: 'DIMENSIONS', offset: 8000, frozen: false,
        anchor1: { kind: 'free', point: { x: 0, y: 5000 } },
        anchor2: { kind: 'free', point: { x: 10000, y: 5000 } },
      },
      {
        id: 'd2', kind: 'linear-v', layer: 'DIMENSIONS', offset: 12000, frozen: false,
        anchor1: { kind: 'free', point: { x: 10000, y: 0 } },
        anchor2: { kind: 'free', point: { x: 10000, y: 5000 } },
      },
    ];
    const ann: Annotation[] = [];
    const out = exportDxf([rect], defaultLayers(), ann, dims);
    const r = await importDxf(out);
    expect(r.polygons).toHaveLength(1);
  });
});
