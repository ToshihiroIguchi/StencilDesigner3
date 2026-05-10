import type { Polygon, Ring, Layer } from '../types';

function umToMm(v: number): number { return v / 1000; }

function cssToRgbInt(css: string): number {
  const r = parseInt(css.slice(1, 3), 16);
  const g = parseInt(css.slice(3, 5), 16);
  const b = parseInt(css.slice(5, 7), 16);
  return (r << 16) | (g << 8) | b;
}

const LTYPE_DEFS: Record<string, string> = {
  CONTINUOUS: '0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0',
  DASHED:     '0\nLTYPE\n2\nDASHED\n70\n0\n3\nDashed _ _ _\n72\n65\n73\n2\n40\n19.0\n49\n12.0\n74\n0\n49\n-7.0\n74\n0',
  HIDDEN:     '0\nLTYPE\n2\nHIDDEN\n70\n0\n3\nHidden __ __\n72\n65\n73\n2\n40\n9.0\n49\n6.0\n74\n0\n49\n-3.0\n74\n0',
  CENTER:     '0\nLTYPE\n2\nCENTER\n70\n0\n3\nCenter ____ _ ____\n72\n65\n73\n4\n40\n50.0\n49\n31.75\n74\n0\n49\n-6.35\n74\n0\n49\n6.35\n74\n0\n49\n-6.35\n74\n0',
  PHANTOM:    '0\nLTYPE\n2\nPHANTOM\n70\n0\n3\nPhantom ____  __  __\n72\n65\n73\n6\n40\n63.5\n49\n31.75\n74\n0\n49\n-6.35\n74\n0\n49\n6.35\n74\n0\n49\n-6.35\n74\n0\n49\n6.35\n74\n0\n49\n-6.35\n74\n0',
  DASHDOT:    '0\nLTYPE\n2\nDASHDOT\n70\n0\n3\nDash dot __·__·\n72\n65\n73\n4\n40\n25.4\n49\n12.7\n74\n0\n49\n-6.35\n74\n0\n49\n0.0\n74\n0\n49\n-6.35\n74\n0',
};

export function exportDxf(
  polygons: Polygon[],
  layers: Layer[],
  options: { aperturesOnly?: boolean } = { aperturesOnly: true }
): string {
  const lines: string[] = [];

  // HEADER
  lines.push('0\nSECTION\n2\nHEADER');
  lines.push('9\n$ACADVER\n1\nAC1015');
  lines.push('0\nENDSEC');

  // TABLES
  lines.push('0\nSECTION\n2\nTABLES');

  // LTYPE table
  const usedLtypes = new Set(layers.map((l) => l.linetype));
  usedLtypes.add('CONTINUOUS');
  const ltypeEntries = [...usedLtypes].filter((lt) => LTYPE_DEFS[lt]);
  lines.push(`0\nTABLE\n2\nLTYPE\n70\n${ltypeEntries.length}`);
  for (const lt of ltypeEntries) lines.push(LTYPE_DEFS[lt]);
  lines.push('0\nENDTAB');

  // LAYER table
  lines.push(`0\nTABLE\n2\nLAYER\n70\n${layers.length}`);
  for (const l of layers) {
    const colorInt = cssToRgbInt(l.color);
    const aciSign = l.visible ? 7 : -7;
    const flags = l.locked ? 4 : 0;
    lines.push('0\nLAYER');
    lines.push(`2\n${l.name}`);
    lines.push(`70\n${flags}`);
    lines.push(`62\n${aciSign}`);
    lines.push(`6\n${l.linetype}`);
    lines.push(`290\n${l.plot ? 1 : 0}`);
    lines.push(`420\n${colorInt}`);
    if (l.lineweight >= 0) lines.push(`370\n${l.lineweight}`);
  }
  lines.push('0\nENDTAB');
  lines.push('0\nENDSEC');

  // ENTITIES
  const apertureNames = new Set(layers.filter((l) => l.isAperture).map((l) => l.name));
  lines.push('0\nSECTION\n2\nENTITIES');
  for (const poly of polygons) {
    if (options.aperturesOnly && !apertureNames.has(poly.layer)) continue;
    writeLwPolyline(lines, poly.outer, poly.layer, true);
    for (const hole of poly.holes) writeLwPolyline(lines, hole, poly.layer, true);
  }
  lines.push('0\nENDSEC');
  lines.push('0\nEOF');
  return lines.join('\n');
}

function writeLwPolyline(lines: string[], ring: Ring, layer: string, closed: boolean): void {
  lines.push('0\nLWPOLYLINE');
  lines.push(`8\n${layer}`);
  lines.push('70\n' + (closed ? '1' : '0'));
  lines.push(`90\n${ring.length}`);
  for (const p of ring) {
    lines.push(`10\n${umToMm(p.x).toFixed(6)}`);
    lines.push(`20\n${umToMm(-p.y).toFixed(6)}`);
  }
}

/** Trigger browser download of the DXF text. */
export function downloadDxf(polygons: Polygon[], layers: Layer[], filename = 'stencil.dxf'): void {
  const content = exportDxf(polygons, layers);
  const blob = new Blob([content], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
