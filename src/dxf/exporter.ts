import type { Polygon, Ring } from '../types';

/** Convert µm to mm for DXF output. */
function umToMm(v: number): number {
  return v / 1000;
}

/** Build a minimal DXF string from polygons (LWPOLYLINE entities). */
export function exportDxf(polygons: Polygon[]): string {
  const lines: string[] = [];

  // DXF header
  lines.push('0\nSECTION\n2\nHEADER\n0\nENDSEC');

  // ENTITIES section
  lines.push('0\nSECTION\n2\nENTITIES');

  for (const poly of polygons) {
    writeLwPolyline(lines, poly.outer, poly.layer, true);
    for (const hole of poly.holes) {
      writeLwPolyline(lines, hole, poly.layer, true);
    }
  }

  lines.push('0\nENDSEC\n0\nEOF');
  return lines.join('\n');
}

function writeLwPolyline(lines: string[], ring: Ring, layer: string, closed: boolean): void {
  lines.push('0\nLWPOLYLINE');
  lines.push(`8\n${layer}`); // layer
  lines.push('70\n' + (closed ? '1' : '0')); // closed flag
  lines.push(`90\n${ring.length}`); // vertex count
  for (const p of ring) {
    lines.push(`10\n${umToMm(p.x).toFixed(6)}`);
    lines.push(`20\n${umToMm(p.y).toFixed(6)}`);
  }
}

/** Trigger browser download of the DXF text. */
export function downloadDxf(polygons: Polygon[], filename = 'stencil.dxf'): void {
  const content = exportDxf(polygons);
  const blob = new Blob([content], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
