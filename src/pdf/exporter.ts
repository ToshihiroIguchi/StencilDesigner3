import { jsPDF } from 'jspdf';
import type { AppState, Polygon, Dimension, Layer, Point, Ring, LineType } from '../types';
import { resolveDimension } from '../core/dimension-resolve';
import { UnitConverter } from '../core/format';

const A4_W = 210, A4_H = 297;
const MARGIN_LR = 10;
const TITLE_H = 12;
const FOOTER_H = 14;

function umToMm(v: number): number { return v / 1000; }

function linetypeToDashMm(lt: LineType): number[] {
  switch (lt) {
    case 'DASHED':  return [2, 1];
    case 'HIDDEN':  return [1, 1];
    case 'CENTER':  return [4, 1, 1, 1];
    case 'PHANTOM': return [4, 1, 1, 1, 1, 1];
    case 'DASHDOT': return [3, 1, 0.5, 1];
    default: return [];
  }
}

interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

export function computeBBox(
  shapes: Polygon[],
  dimensions: Dimension[],
  layers: Layer[],
): BBox | null {
  const visibleLayerNames = new Set(layers.filter(l => l.visible).map(l => l.name));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;

  const expand = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    any = true;
  };

  for (const s of shapes) {
    if (!visibleLayerNames.has(s.layer)) continue;
    for (const ring of [s.outer, ...s.holes]) {
      for (const p of ring) expand(p.x, p.y);
    }
  }
  for (const d of dimensions) {
    if (!visibleLayerNames.has(d.layer)) continue;
    const { p1, p2 } = resolveDimension(d, shapes);
    expand(p1.x, p1.y);
    expand(p2.x, p2.y);
    // Include the actual dimension line position (d.offset is its world coordinate)
    if (d.kind === 'linear-h') {
      expand(p1.x, d.offset);  // dim line drawn at Y = d.offset
      expand(p2.x, d.offset);
    } else if (d.kind === 'linear-v') {
      expand(d.offset, p1.y);  // dim line drawn at X = d.offset
      expand(d.offset, p2.y);
    }
  }
  if (!any) return null;

  // 8% padding on each side for labels and extension-line overshoot
  const pw = (maxX - minX) * 0.08 || 500;
  const ph = (maxY - minY) * 0.08 || 500;
  return { minX: minX - pw, minY: minY - ph, maxX: maxX + pw, maxY: maxY + ph };
}

export function pickOrientation(bbox: BBox): 'portrait' | 'landscape' {
  const w = umToMm(bbox.maxX - bbox.minX);
  const h = umToMm(bbox.maxY - bbox.minY);
  if (w <= 0 || h <= 0) return 'portrait';
  const portraitDrawW = A4_W - 2 * MARGIN_LR;
  const portraitDrawH = A4_H - TITLE_H - FOOTER_H;
  const landscapeDrawW = A4_H - 2 * MARGIN_LR;
  const landscapeDrawH = A4_W - TITLE_H - FOOTER_H;
  const sp = Math.min(portraitDrawW / w, portraitDrawH / h);
  const sl = Math.min(landscapeDrawW / w, landscapeDrawH / h);
  return sl > sp ? 'landscape' : 'portrait';
}

export function formatScaleRatio(scale: number): string {
  if (scale >= 1) {
    return `${scale.toFixed(scale >= 10 ? 0 : 1)}:1`;
  }
  const inv = 1 / scale;
  return `1:${inv >= 10 ? Math.round(inv) : inv.toFixed(1)}`;
}

/** Format scale bar label, respecting displayUnit. */
export function formatBarLabel(mm: number, unit: 'mm' | 'um'): string {
  if (unit === 'um') {
    return `${Math.round(mm * 1000)} µm`;
  }
  if (mm >= 1) return `${mm} mm`;
  return `${mm.toFixed(2)} mm`;
}

interface FrameInfo {
  pdf: jsPDF;
  orientation: 'portrait' | 'landscape';
  pageW: number; pageH: number;
  drawX: number; drawY: number; drawW: number; drawH: number;
  scale: number;
  offsetX: number; offsetY: number;
  bbox: BBox;
}

function setupFrame(bbox: BBox): FrameInfo {
  const orientation = pickOrientation(bbox);
  const pageW = orientation === 'portrait' ? A4_W : A4_H;
  const pageH = orientation === 'portrait' ? A4_H : A4_W;
  const drawX = MARGIN_LR;
  const drawY = TITLE_H;
  const drawW = pageW - 2 * MARGIN_LR;
  const drawH = pageH - TITLE_H - FOOTER_H;
  const bboxWmm = umToMm(bbox.maxX - bbox.minX) || 1;
  const bboxHmm = umToMm(bbox.maxY - bbox.minY) || 1;
  const scale = Math.min(drawW / bboxWmm, drawH / bboxHmm);
  const usedW = bboxWmm * scale;
  const usedH = bboxHmm * scale;
  const offsetX = drawX + (drawW - usedW) / 2;
  const offsetY = drawY + (drawH - usedH) / 2;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation });
  return { pdf, orientation, pageW, pageH, drawX, drawY, drawW, drawH, scale, offsetX, offsetY, bbox };
}

function wx(x: number, f: FrameInfo): number { return f.offsetX + (umToMm(x) - umToMm(f.bbox.minX)) * f.scale; }
function wy(y: number, f: FrameInfo): number { return f.offsetY + (umToMm(y) - umToMm(f.bbox.minY)) * f.scale; }

function drawRing(pdf: jsPDF, ring: Ring, f: FrameInfo): void {
  if (ring.length < 2) return;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    pdf.line(wx(a.x, f), wy(a.y, f), wx(b.x, f), wy(b.y, f));
  }
}

function drawShapes(f: FrameInfo, shapes: Polygon[], layers: Layer[]): void {
  const layerMap = new Map(layers.map(l => [l.name, l]));
  for (const s of shapes) {
    const layer = layerMap.get(s.layer);
    if (!layer || !layer.visible) continue;
    f.pdf.setDrawColor(layer.color);
    f.pdf.setLineWidth(0.15);
    f.pdf.setLineDashPattern(linetypeToDashMm(layer.linetype), 0);
    drawRing(f.pdf, s.outer, f);
    for (const h of s.holes) drawRing(f.pdf, h, f);
  }
  f.pdf.setLineDashPattern([], 0);
}

const DIM_FONT = 3.0;
const DIM_LABEL_PAD = 0.6;
const DIM_ARROW = 1.0;
const DIM_ANGLE = 20 * Math.PI / 180;
const DIM_EXT_GAP = 0.5;
const DIM_EXT_OVER = 0.8;
const DIM_TEXT_GAP = 1.5;

function drawArrowhead(pdf: jsPDF, x: number, y: number, angle: number): void {
  pdf.line(x, y, x + DIM_ARROW * Math.cos(angle + DIM_ANGLE), y + DIM_ARROW * Math.sin(angle + DIM_ANGLE));
  pdf.line(x, y, x + DIM_ARROW * Math.cos(angle - DIM_ANGLE), y + DIM_ARROW * Math.sin(angle - DIM_ANGLE));
}

function drawDimLabelPdf(
  pdf: jsPDF,
  label: string,
  x: number,
  y: number,
  align: 'left' | 'right' | 'center',
  color: string,
): void {
  pdf.setFontSize(DIM_FONT);
  const w = pdf.getTextWidth(label);
  const h = DIM_FONT * 0.9;
  let bgX = x;
  if (align === 'center') bgX = x - w / 2;
  else if (align === 'right') bgX = x - w;
  pdf.setFillColor('#ffffff');
  pdf.rect(bgX - DIM_LABEL_PAD, y - h / 2 - DIM_LABEL_PAD,
           w + DIM_LABEL_PAD * 2, h + DIM_LABEL_PAD * 2, 'F');
  pdf.setTextColor(color);
  pdf.text(label, x, y, { align, baseline: 'middle' });
}

function renderOneDimensionPdf(
  f: FrameInfo,
  kind: Dimension['kind'],
  p1: Point,
  p2: Point,
  offset: number,
  color: string,
  unit: 'mm' | 'um',
  frozen: boolean,
): void {
  const pdf = f.pdf;
  pdf.setDrawColor(color);
  pdf.setLineWidth(frozen ? 0.08 : 0.1);
  pdf.setLineDashPattern([], 0);

  if (kind === 'centerline') {
    const c1x = wx(p1.x, f), c1y = wy(p1.y, f);
    const c2x = wx(p2.x, f), c2y = wy(p2.y, f);
    pdf.setLineDashPattern([3, 1], 0);
    pdf.line(c1x, c1y, c2x, c2y);
    return;
  }

  if (kind === 'arrow') {
    const c1x = wx(p1.x, f), c1y = wy(p1.y, f);
    const c2x = wx(p2.x, f), c2y = wy(p2.y, f);
    pdf.line(c1x, c1y, c2x, c2y);
    const angle = Math.atan2(c2y - c1y, c2x - c1x) + Math.PI;
    drawArrowhead(pdf, c2x, c2y, angle);
    return;
  }

  if (kind === 'linear-h') {
    const c1x = wx(p1.x, f), c1y = wy(p1.y, f);
    const c2x = wx(p2.x, f), c2y = wy(p2.y, f);
    const cdy = wy(offset, f); // offset is world Y of the dimension line

    const d1 = Math.sign(cdy - c1y) || 1;
    const d2 = Math.sign(cdy - c2y) || 1;
    pdf.line(c1x, c1y + DIM_EXT_GAP * d1, c1x, cdy + DIM_EXT_OVER * d1);
    pdf.line(c2x, c2y + DIM_EXT_GAP * d2, c2x, cdy + DIM_EXT_OVER * d2);
    pdf.line(c1x, cdy, c2x, cdy);

    const dirX = Math.sign(c2x - c1x);
    drawArrowhead(pdf, c1x, cdy, dirX > 0 ? 0 : Math.PI);
    drawArrowhead(pdf, c2x, cdy, dirX > 0 ? Math.PI : 0);

    const label = UnitConverter.formatOutput(Math.abs(p2.x - p1.x), unit, true);
    const textDir = -(d1 || 1);
    drawDimLabelPdf(pdf, label, (c1x + c2x) / 2, cdy + DIM_TEXT_GAP * textDir, 'center', color);
  } else {
    // linear-v
    const c1x = wx(p1.x, f), c1y = wy(p1.y, f);
    const c2x = wx(p2.x, f), c2y = wy(p2.y, f);
    const cdx = wx(offset, f); // offset is world X of the dimension line

    const d1 = Math.sign(cdx - c1x) || 1;
    const d2 = Math.sign(cdx - c2x) || 1;
    pdf.line(c1x + DIM_EXT_GAP * d1, c1y, cdx + DIM_EXT_OVER * d1, c1y);
    pdf.line(c2x + DIM_EXT_GAP * d2, c2y, cdx + DIM_EXT_OVER * d2, c2y);
    pdf.line(cdx, c1y, cdx, c2y);

    const dirY = Math.sign(c2y - c1y);
    drawArrowhead(pdf, cdx, c1y, dirY > 0 ? Math.PI / 2 : -Math.PI / 2);
    drawArrowhead(pdf, cdx, c2y, dirY > 0 ? -Math.PI / 2 : Math.PI / 2);

    const label = UnitConverter.formatOutput(Math.abs(p2.y - p1.y), unit, true);
    const textDir = -(d1 || 1);
    const tx = cdx + DIM_TEXT_GAP * textDir;
    drawDimLabelPdf(pdf, label, tx, (c1y + c2y) / 2, textDir > 0 ? 'left' : 'right', color);
  }
}

function drawDimensions(
  f: FrameInfo,
  dimensions: Dimension[],
  shapes: Polygon[],
  layers: Layer[],
  unit: 'mm' | 'um',
): void {
  const layerMap = new Map(layers.map(l => [l.name, l]));
  for (const d of dimensions) {
    const layer = layerMap.get(d.layer);
    if (!layer || !layer.visible) continue;
    const { p1, p2, frozen } = resolveDimension(d, shapes);
    renderOneDimensionPdf(f, d.kind, p1, p2, d.offset, frozen ? '#888888' : layer.color, unit, frozen);
  }
}

function drawTitleBar(f: FrameInfo, docName: string): void {
  const { pdf, pageW } = f;
  pdf.setFontSize(11);
  pdf.setTextColor('#333333');
  pdf.setFont('helvetica', 'bold');
  pdf.text('StencilDesigner3', MARGIN_LR, 8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(docName, MARGIN_LR + 40, 8);
  const date = new Date().toISOString().slice(0, 10);
  pdf.text(date, pageW - MARGIN_LR, 8, { align: 'right' });
  pdf.setDrawColor('#888888');
  pdf.setLineWidth(0.2);
  pdf.line(MARGIN_LR, TITLE_H - 2, pageW - MARGIN_LR, TITLE_H - 2);
}

export function pickScaleBarWorldMm(scale: number): number {
  const targetWorld = 30 / scale;
  const nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let best = nice[0];
  for (const n of nice) if (n <= targetWorld) best = n;
  return best;
}

function drawFooter(f: FrameInfo, layers: Layer[], unit: 'mm' | 'um'): void {
  const { pdf, pageW, pageH } = f;
  const y = pageH - FOOTER_H + 4;
  pdf.setDrawColor('#888888');
  pdf.setLineWidth(0.2);
  pdf.line(MARGIN_LR, pageH - FOOTER_H + 1, pageW - MARGIN_LR, pageH - FOOTER_H + 1);

  let x = MARGIN_LR;
  pdf.setFontSize(8);
  pdf.setTextColor('#333333');
  for (const l of layers.filter(l => l.visible)) {
    pdf.setFillColor(l.color);
    pdf.rect(x, y - 2, 3, 3, 'F');
    pdf.text(l.name, x + 4, y + 0.5);
    x += 4 + pdf.getTextWidth(l.name) + 5;
    if (x > pageW * 0.65) break;
  }

  const scaleText = `Scale ${formatScaleRatio(f.scale)}`;
  pdf.setFontSize(9);
  pdf.text(scaleText, pageW - MARGIN_LR, y + 1, { align: 'right' });

  const barWorldMm = pickScaleBarWorldMm(f.scale);
  const barPaperMm = barWorldMm * f.scale;
  const barX = pageW - MARGIN_LR - barPaperMm;
  const barY = y + 6;
  pdf.setDrawColor('#000000');
  pdf.setLineWidth(0.3);
  pdf.line(barX, barY, barX + barPaperMm, barY);
  pdf.line(barX, barY - 1, barX, barY + 1);
  pdf.line(barX + barPaperMm, barY - 1, barX + barPaperMm, barY + 1);
  pdf.setFontSize(7);
  pdf.text(formatBarLabel(barWorldMm, unit), barX + barPaperMm / 2, barY + 3.5, { align: 'center' });
}

export function buildPdf(state: AppState, docName: string): jsPDF | null {
  const bbox = computeBBox(state.shapes, state.dimensions, state.layers);
  if (!bbox) return null;
  const f = setupFrame(bbox);
  drawTitleBar(f, docName || 'Untitled');
  drawShapes(f, state.shapes, state.layers);
  drawDimensions(f, state.dimensions, state.shapes, state.layers, state.displayUnit);
  drawFooter(f, state.layers, state.displayUnit);
  return f.pdf;
}

export function downloadPdf(state: AppState, docName: string, filename?: string): boolean {
  const pdf = buildPdf(state, docName);
  if (!pdf) return false;
  pdf.save(filename ?? `${docName || 'stencil'}.pdf`);
  return true;
}
