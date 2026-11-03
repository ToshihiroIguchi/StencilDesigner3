import { describe, it, expect } from 'vitest';
import { importDxf } from '../../src/dxf/importer';
import { exportDxf } from '../../src/dxf/exporter';
import { defaultLayers } from '../../src/types';
import type { Dimension, Polygon } from '../../src/types';

function rect(id: string, layer: string): Polygon {
  return {
    id, layer, holes: [],
    outer: [{ x: 0, y: 0 }, { x: 0, y: 5000 }, { x: 10000, y: 5000 }, { x: 10000, y: 0 }],
  } as unknown as Polygon;
}

function dim(kind: Dimension['kind']): Dimension {
  return {
    id: 'd', kind, layer: 'DIMENSIONS', offset: 8000, frozen: false,
    anchor1: { kind: 'free', point: { x: 0, y: 0 } },
    anchor2: { kind: 'free', point: { x: 10000, y: 5000 } },
  } as unknown as Dimension;
}

describe('DXF hidden layers and dimension round trip', () => {
  it('does not export polygons on hidden layers', () => {
    const layers = defaultLayers().map((l) => ({ ...l }));
    const apt = layers.find((l) => l.isAperture)!;
    apt.visible = false;
    const dxf = exportDxf([rect('a', apt.name)], layers, [], []);
    expect(dxf).not.toContain('LWPOLYLINE');
  });

  for (const kind of ['linear-h', 'linear-v', 'centerline', 'arrow'] as const) {
    it(`does not create polygons from ${kind} dimension LINEs`, async () => {
      const layers = defaultLayers();
      const apt = layers.find((l) => l.isAperture)!;
      const dxf = exportDxf([rect('a', apt.name)], layers, [], [dim(kind)]);
      const r = await importDxf(dxf);
      const onDim = r.polygons.filter((p) => p.layer === 'DIMENSIONS');
      expect(onDim).toHaveLength(0);
      expect(r.polygons.filter((p) => p.layer === apt.name)).toHaveLength(1);
    });
  }
});
