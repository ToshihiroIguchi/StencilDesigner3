import { DIMENSIONS_LAYER, type Polygon, type Ring, type Layer, type Annotation, type Dimension, type Point } from '../types';
import { resolveDimension } from '../core/dimension-resolve';
import { UnitConverter } from '../core/format';
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

export interface DxfExportOptions {
  aperturesOnly?: boolean;
  includeAnnotations?: boolean;
  includeDimensions?: boolean;
  displayUnit?: 'mm' | 'um';
}

function writeLine(lines: string[], p1: Point, p2: Point, layer: string): void {
  lines.push('0\nLINE');
  lines.push(`8\n${layer}`);
  lines.push(`10\n${umToMm(p1.x).toFixed(6)}`);
  lines.push(`20\n${umToMm(-p1.y).toFixed(6)}`);
  lines.push('30\n0.0');
  lines.push(`11\n${umToMm(p2.x).toFixed(6)}`);
  lines.push(`21\n${umToMm(-p2.y).toFixed(6)}`);
  lines.push('31\n0.0');
}

function writeArrowhead(lines: string[], tip: Point, angleRad: number, layer: string): void {
  const arrowLenUm = 1500; // 1.5mm
  const arrowAngle = Math.PI / 6; // 30 deg
  const p1: Point = {
    x: Math.round(tip.x + arrowLenUm * Math.cos(angleRad + arrowAngle)),
    y: Math.round(tip.y + arrowLenUm * Math.sin(angleRad + arrowAngle)),
  };
  const p2: Point = {
    x: Math.round(tip.x + arrowLenUm * Math.cos(angleRad - arrowAngle)),
    y: Math.round(tip.y + arrowLenUm * Math.sin(angleRad - arrowAngle)),
  };
  writeLine(lines, tip, p1, layer);
  writeLine(lines, tip, p2, layer);
}

function writeDimMtext(lines: string[], text: string, xUm: number, yUm: number, heightUm: number, layer: string): void {
  const content = escapeMtext(text);
  lines.push('0\nMTEXT');
  lines.push(`8\n${layer}`);
  lines.push(`10\n${umToMm(xUm).toFixed(6)}`);
  lines.push(`20\n${umToMm(-yUm).toFixed(6)}`);
  lines.push('30\n0.0');
  lines.push(`40\n${umToMm(heightUm).toFixed(6)}`);
  lines.push('71\n5'); // attachment: Middle Center
  lines.push('73\n2'); // line spacing: Exactly
  lines.push('44\n1.2');
  lines.push(`1\n${content}`);
}

export function exportDxf(
  polygons: Polygon[],
  layers: Layer[],
  annotations: Annotation[] = [],
  dimensionsOrOptions?: Dimension[] | DxfExportOptions,
  maybeOptions?: DxfExportOptions
): string {
  let dimensions: Dimension[] = [];
  let options: DxfExportOptions = { aperturesOnly: true, includeAnnotations: true, includeDimensions: true, displayUnit: 'mm' };

  if (Array.isArray(dimensionsOrOptions)) {
    dimensions = dimensionsOrOptions;
    options = { ...options, ...maybeOptions };
  } else if (dimensionsOrOptions) {
    options = { ...options, ...dimensionsOrOptions };
  }

  const allLayers = [...layers];
  if (dimensions.length > 0 && !allLayers.some((l) => l.name === 'DIMENSIONS')) {
    allLayers.push({ ...DIMENSIONS_LAYER });
  }

  const lines: string[] = [];

  // HEADER
  lines.push('0\nSECTION\n2\nHEADER');
  lines.push('9\n$ACADVER\n1\nAC1015');
  lines.push('0\nENDSEC');

  // TABLES
  lines.push('0\nSECTION\n2\nTABLES');

  // LTYPE table
  const usedLtypes = new Set(allLayers.map((l) => l.linetype));
  usedLtypes.add('CONTINUOUS');
  const ltypeEntries = [...usedLtypes].filter((lt) => LTYPE_DEFS[lt]);
  lines.push(`0\nTABLE\n2\nLTYPE\n70\n${ltypeEntries.length}`);
  for (const lt of ltypeEntries) lines.push(LTYPE_DEFS[lt]);
  lines.push('0\nENDTAB');

  // LAYER table
  lines.push(`0\nTABLE\n2\nLAYER\n70\n${allLayers.length}`);
  for (const l of allLayers) {
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
  const apertureNames = new Set(allLayers.filter((l) => l.isAperture).map((l) => l.name));
  const layerMap = new Map(allLayers.map((l) => [l.name, l]));
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
  if (options.includeDimensions !== false) {
    const unit = options.displayUnit ?? 'mm';
    for (const dim of dimensions) {
      const layer = layerMap.get(dim.layer);
      if (layer && !layer.visible) continue;
      const { p1, p2 } = resolveDimension(dim, polygons);

      if (dim.kind === 'centerline') {
        writeLine(lines, p1, p2, dim.layer);
      } else if (dim.kind === 'arrow') {
        writeLine(lines, p1, p2, dim.layer);
        const dir = Math.atan2(p1.y - p2.y, p1.x - p2.x);
        writeArrowhead(lines, p2, dir, dim.layer);
      } else if (dim.kind === 'linear-h') {
        const cdy = dim.offset;
        const e1 = { x: p1.x, y: cdy };
        const e2 = { x: p2.x, y: cdy };
        writeLine(lines, p1, e1, dim.layer);
        writeLine(lines, p2, e2, dim.layer);
        writeLine(lines, e1, e2, dim.layer);

        const dirX = Math.sign(p2.x - p1.x) || 1;
        writeArrowhead(lines, e1, dirX > 0 ? 0 : Math.PI, dim.layer);
        writeArrowhead(lines, e2, dirX > 0 ? Math.PI : 0, dim.layer);

        const label = UnitConverter.formatOutput(Math.abs(p2.x - p1.x), unit, true);
        const midX = Math.round((p1.x + p2.x) / 2);
        writeDimMtext(lines, label, midX, cdy, 2500, dim.layer);
      } else if (dim.kind === 'linear-v') {
        const cdx = dim.offset;
        const e1 = { x: cdx, y: p1.y };
        const e2 = { x: cdx, y: p2.y };
        writeLine(lines, p1, e1, dim.layer);
        writeLine(lines, p2, e2, dim.layer);
        writeLine(lines, e1, e2, dim.layer);

        const dirY = Math.sign(p2.y - p1.y) || 1;
        writeArrowhead(lines, e1, dirY > 0 ? Math.PI / 2 : -Math.PI / 2, dim.layer);
        writeArrowhead(lines, e2, dirY > 0 ? -Math.PI / 2 : Math.PI / 2, dim.layer);

        const label = UnitConverter.formatOutput(Math.abs(p2.y - p1.y), unit, true);
        const midY = Math.round((p1.y + p2.y) / 2);
        writeDimMtext(lines, label, cdx, midY, 2500, dim.layer);
      }
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
export function downloadDxf(
  polygons: Polygon[],
  layers: Layer[],
  annotations: Annotation[] = [],
  dimensions: Dimension[] = [],
  filename = 'stencil.dxf',
  unit: 'mm' | 'um' = 'mm'
): void {
  const content = exportDxf(polygons, layers, annotations, dimensions, { displayUnit: unit });
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
