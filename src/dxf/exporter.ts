import type { Polygon, Ring, Layer, Annotation } from '../types';
import { nearestAci } from './aci';

function umToMm(v: number): number { return v / 1000; }

function escapeMtext(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (ch === '\\') { out += '\\\\'; }
    else if (ch === '{') { out += '\\{'; }
    else if (ch === '}') { out += '\\}'; }
    else if (ch === '\n') { out += '\\P'; }
    else {
      const cp = ch.codePointAt(0)!;
      // BMP non-ASCII → \U+XXXX escape for AC1015 compatibility
      if (cp > 0x7E && cp <= 0xFFFF) { out += `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`; }
      else { out += ch; }
    }
  }
  return out;
}

function writeMtext(lines: string[], ann: Annotation): void {
  const content = escapeMtext(ann.text);
  lines.push('0\nMTEXT');
  lines.push(`8\n${ann.layer}`);
  lines.push(`10\n${umToMm(ann.origin.x).toFixed(6)}`);
  lines.push(`20\n${umToMm(-ann.origin.y).toFixed(6)}`);
  lines.push('30\n0.0');
  lines.push(`40\n${umToMm(ann.heightUm).toFixed(6)}`);
  lines.push('71\n1');    // attachment: Top Left
  lines.push('73\n2');    // line spacing: Exactly
  lines.push('44\n1.2'); // line spacing factor — matches renderer lineHeight * 1.2
  // DXF group 3 holds continuation chunks (max 250 chars each), group 1 holds the final chunk
  let remaining = content;
  while (remaining.length > 250) {
    lines.push(`3\n${remaining.slice(0, 250)}`);
    remaining = remaining.slice(250);
  }
  lines.push(`1\n${remaining}`);
}

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
  annotations: Annotation[] = [],
  options: { aperturesOnly?: boolean; includeAnnotations?: boolean } = { aperturesOnly: true, includeAnnotations: true }
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
    const aci = nearestAci(l.color);
    const aciSign = l.visible ? aci : -aci;
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
  const layerMap = new Map(layers.map((l) => [l.name, l]));
  lines.push('0\nSECTION\n2\nENTITIES');
  for (const poly of polygons) {
    if (options.aperturesOnly && !apertureNames.has(poly.layer)) continue;
    writeLwPolyline(lines, poly.outer, poly.layer, true);
    for (const hole of poly.holes) writeLwPolyline(lines, hole, poly.layer, true);
  }
  if (options.includeAnnotations !== false) {
    for (const ann of annotations) {
      if (!ann.text.trim()) continue;
      const layer = layerMap.get(ann.layer);
      if (layer && !layer.visible) continue;
      writeMtext(lines, ann);
    }
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
export function downloadDxf(polygons: Polygon[], layers: Layer[], annotations: Annotation[] = [], filename = 'stencil.dxf'): void {
  const content = exportDxf(polygons, layers, annotations);
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
