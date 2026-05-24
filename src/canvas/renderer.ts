import type { AppState, Annotation, Dimension, DrcError, Layer, Point, Polygon, Ring, ViewTransform } from '../types';
import { worldToCanvas } from '../types';
import type { SnapResult } from '../core/snap';
import { selectedIds } from '../core/transform';
import { UnitConverter } from '../core/format';
import { resolveDimension } from '../core/dimension-resolve';

function linetypeToDash(lt: string): number[] {
  switch (lt) {
    case 'DASHED':  return [8, 4];
    case 'HIDDEN':  return [4, 4];
    case 'CENTER':  return [12, 4, 4, 4];
    case 'PHANTOM': return [12, 4, 4, 4, 4, 4];
    case 'DASHDOT': return [10, 4, 2, 4];
    default: return [];
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const COLORS = {
  background: '#1e1e2e',
  backgroundLight: '#f5f5f0',
  grid: 'rgba(100,100,120,0.25)',
  gridLight: 'rgba(150,150,160,0.35)',
  ruler: '#2a2a3a',
  rulerLight: '#e0e0e8',
  rulerText: '#aaaacc',
  rulerTextLight: '#666688',
  shape: '#4a9eff',
  shapeFill: 'rgba(74,158,255,0.15)',
  shapeSelected: '#ff9f4a',
  shapeFillSelected: 'rgba(255,159,74,0.25)',
  vertex: '#ffdd44',
  vertexSkip: '#555570',
  vertexBad: '#ff4444',
  vertexHover: '#ffffff',
  snapIndicator: '#00ff88',
  draftShape: 'rgba(100,200,100,0.7)',
  draftFill: 'rgba(100,200,100,0.1)',
  drcError: '#f38ba8',
  drcErrorFill: 'rgba(243,139,168,0.12)',
};

const RULER_SIZE = 24; // pixels

export interface DraftShape {
  type: 'rect' | 'circle' | 'fillet-preview' | 'polygon' | 'line';
  points: { x: number; y: number }[]; // world coordinates
  selfIntersects?: boolean; // polygon only: highlight invalid state
  willClose?: boolean;     // polygon only: hover near first vertex
}

export type FilletVertexStatus = 'ok' | 'skip' | 'bad' | 'hover';

/** Live distance overlay rendered by MeasureTool. */
export interface MeasureOverlay { p1: Point; p2: Point; }

/** In-progress dimension drawn by DimensionTool or CenterlineTool. */
export interface DimDraft {
  p1: Point;
  p2?: Point;
  kind?: 'linear-h' | 'linear-v' | 'centerline' | 'arrow';
  offset?: number;
}

/** HUD label shown near the cursor during draw-tool drag. */
export interface DrawHud { label: string; worldPt: Point; }

export interface RendererExtras {
  measureOverlay?: MeasureOverlay;
  dimDraft?: DimDraft;
  selectedDimIds?: Set<string>;
  textPreviewPolys?: Polygon[];
  annotationPreviewPt?: Point;
  selectedAnnotationIds?: Set<string>;
  drawHud?: DrawHud;
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private isDark: boolean;

  constructor(canvas: HTMLCanvasElement, isDark = true) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.ctx = ctx;
    this.isDark = isDark;
  }

  setTheme(isDark: boolean): void {
    this.isDark = isDark;
  }

  /** Resize canvas to fill its CSS container. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  get width(): number { return this.canvas.width; }
  get height(): number { return this.canvas.height; }

  render(
    state: AppState,
    draft?: DraftShape,
    snap?: SnapResult,
    showAllVertices = false,
    rubberBand?: { start: { x: number; y: number }; end: { x: number; y: number } },
    filletStatuses?: Map<string, FilletVertexStatus>,
    drcErrors?: DrcError[],
    diffBaseId?: string,
    extras?: RendererExtras,
  ): void {
    const ctx = this.ctx;
    const vt: ViewTransform = { zoom: state.zoom, panX: state.panX, panY: state.panY };
    const c = this.isDark ? COLORS : { ...COLORS, background: COLORS.backgroundLight, grid: COLORS.gridLight, ruler: COLORS.rulerLight, rulerText: COLORS.rulerTextLight };

    // Clear
    ctx.fillStyle = c.background;
    ctx.fillRect(0, 0, this.width, this.height);

    // Grid
    this.drawGrid(state, vt);

    // Save clip for canvas area (exclude rulers)
    ctx.save();
    ctx.beginPath();
    ctx.rect(RULER_SIZE, RULER_SIZE, this.width - RULER_SIZE, this.height - RULER_SIZE);
    ctx.clip();

    // Shapes
    const selIds = selectedIds(state.selection);
    const drcErrorIds = new Set(
      drcErrors?.flatMap((e) => e.shapeId2 ? [e.shapeId, e.shapeId2] : [e.shapeId]) ?? [],
    );
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    for (const shape of state.shapes) {
      const layer = layerMap.get(shape.layer);
      if (layer && !layer.visible) continue;
      this.drawPolygon(shape, selIds.has(shape.id), vt, showAllVertices, filletStatuses, drcErrorIds.has(shape.id), layer);
    }

    // Diff BASE label (step 2: user has picked BASE, now picking CUT)
    if (diffBaseId) {
      const baseShape = state.shapes.find((s) => s.id === diffBaseId);
      if (baseShape) this.drawDiffLabel(baseShape, 'BASE', vt);
    }

    // DRC violation markers
    if (drcErrors) {
      for (const e of drcErrors) {
        if (e.loc) this.drawDrcMarker(e.loc, vt);
      }
    }

    // Draft (preview while drawing)
    if (draft) {
      this.drawDraft(draft, vt);
    }

    // Text tool live preview
    if (extras?.textPreviewPolys) {
      this.drawTextPreview(extras.textPreviewPolys, vt);
    }

    // Snap indicator
    if (snap && state.snapEnabled) {
      this.drawSnapIndicator(snap, vt);
    }

    // Annotations (notes exported to DXF as MTEXT on visible layers)
    if (state.annotations.length > 0) {
      this.drawAnnotations(state.annotations, layerMap, extras?.selectedAnnotationIds ?? new Set(), vt);
    }

    // Annotation tool placement preview
    if (extras?.annotationPreviewPt) {
      this.drawAnnotationPreview(extras.annotationPreviewPt, vt);
    }

    // Dimensions
    if (state.dimensions.length > 0) {
      this.drawDimensions(state.dimensions, state.shapes, layerMap, extras?.selectedDimIds ?? new Set(), state.displayUnit, vt);
    }

    // In-progress dimension draft
    if (extras?.dimDraft) {
      this.drawDimDraft(extras.dimDraft, vt);
    }

    // Measure overlay
    if (extras?.measureOverlay) {
      this.drawMeasureOverlay(extras.measureOverlay, state.displayUnit, vt);
    }

    // Rubber-band selection rectangle
    if (rubberBand) {
      this.drawRubberBand(rubberBand.start, rubberBand.end);
    }

    // Draw-tool HUD (dimensions near cursor during freehand drag)
    if (extras?.drawHud) {
      this.drawHud(extras.drawHud, vt);
    }

    ctx.restore();

    // Rulers (drawn on top, outside clip)
    this.drawRulers(state, vt);
  }

  private drawSnapIndicator(snap: SnapResult, vt: ViewTransform): void {
    const ctx = this.ctx;
    const cp = worldToCanvas(snap.point.x, snap.point.y, vt);
    ctx.strokeStyle = COLORS.snapIndicator;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    switch (snap.kind) {
      case 'vertex':
        // Square
        ctx.rect(cp.x - 4, cp.y - 4, 8, 8);
        break;
      case 'midpoint':
        // Triangle (pointing up)
        ctx.moveTo(cp.x, cp.y - 5);
        ctx.lineTo(cp.x + 4.5, cp.y + 3.5);
        ctx.lineTo(cp.x - 4.5, cp.y + 3.5);
        ctx.closePath();
        break;
      case 'center':
        // Concentric circle with crosshair
        ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
        ctx.moveTo(cp.x - 7, cp.y); ctx.lineTo(cp.x + 7, cp.y);
        ctx.moveTo(cp.x, cp.y - 7); ctx.lineTo(cp.x, cp.y + 7);
        break;
      case 'edge':
        // Two parallel lines (‖)
        ctx.moveTo(cp.x - 4, cp.y - 4); ctx.lineTo(cp.x - 4, cp.y + 4);
        ctx.moveTo(cp.x + 4, cp.y - 4); ctx.lineTo(cp.x + 4, cp.y + 4);
        break;
      default:
        // Grid: circle
        ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  private drawGrid(state: AppState, vt: ViewTransform): void {
    const ctx = this.ctx;
    const gs = state.gridSize; // µm

    const worldLeft = (RULER_SIZE - vt.panX) / vt.zoom;
    const worldTop = (RULER_SIZE - vt.panY) / vt.zoom;
    const worldRight = (this.width - vt.panX) / vt.zoom;
    const worldBottom = (this.height - vt.panY) / vt.zoom;

    // Sub-grid lines (gridSize / 5), only when ≥ 8px apart
    const subGs = gs / 5;
    if (subGs * vt.zoom >= 8) {
      const subColor = this.isDark ? 'rgba(100,100,120,0.10)' : 'rgba(150,150,160,0.15)';
      ctx.strokeStyle = subColor;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const subXi = Math.floor(worldLeft / subGs);
      for (let i = subXi; i * subGs <= worldRight; i++) {
        if (i % 5 === 0) continue;
        const cx = i * subGs * vt.zoom + vt.panX;
        if (cx < RULER_SIZE) continue;
        ctx.moveTo(cx, RULER_SIZE);
        ctx.lineTo(cx, this.height);
      }
      const subYi = Math.floor(worldTop / subGs);
      for (let j = subYi; j * subGs <= worldBottom; j++) {
        if (j % 5 === 0) continue;
        const cy = j * subGs * vt.zoom + vt.panY;
        if (cy < RULER_SIZE) continue;
        ctx.moveTo(RULER_SIZE, cy);
        ctx.lineTo(this.width, cy);
      }
      ctx.stroke();
    }

    // Major grid lines
    const gridColor = this.isDark ? COLORS.grid : COLORS.gridLight;
    const startX = Math.floor(worldLeft / gs) * gs;
    const startY = Math.floor(worldTop / gs) * gs;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();

    for (let wx = startX; wx <= worldRight; wx += gs) {
      const cx = wx * vt.zoom + vt.panX;
      if (cx < RULER_SIZE) continue;
      ctx.moveTo(cx, RULER_SIZE);
      ctx.lineTo(cx, this.height);
    }
    for (let wy = startY; wy <= worldBottom; wy += gs) {
      const cy = wy * vt.zoom + vt.panY;
      if (cy < RULER_SIZE) continue;
      ctx.moveTo(RULER_SIZE, cy);
      ctx.lineTo(this.width, cy);
    }
    ctx.stroke();
  }

  private drawPolygon(
    poly: Polygon,
    selected: boolean,
    vt: ViewTransform,
    showAllVertices = false,
    filletStatuses?: Map<string, FilletVertexStatus>,
    drcError = false,
    layer?: Layer,
  ): void {
    const ctx = this.ctx;
    const strokeColor = selected ? COLORS.shapeSelected : (layer?.color ?? COLORS.shape);
    const fillColor = hexToRgba(strokeColor, selected ? 0.25 : 0.15);
    ctx.lineWidth = 1;

    // Locked layers render at half opacity
    ctx.globalAlpha = layer?.locked ? 0.5 : 1.0;

    // Apply linetype dash pattern
    ctx.setLineDash(layer ? linetypeToDash(layer.linetype) : []);

    // Fill with even-odd rule for holes
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.beginPath();
    this.tracePath(poly.outer, vt);
    for (const hole of poly.holes) {
      this.tracePath(hole, vt);
    }
    ctx.save();
    ctx.clip('evenodd');
    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();

    // Stroke outline
    ctx.beginPath();
    this.tracePath(poly.outer, vt);
    ctx.stroke();
    for (const hole of poly.holes) {
      ctx.beginPath();
      this.tracePath(hole, vt);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // DRC error overlay
    if (drcError) {
      ctx.save();
      ctx.strokeStyle = COLORS.drcError;
      ctx.fillStyle = COLORS.drcErrorFill;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      this.tracePath(poly.outer, vt);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Vertices
    if (selected || showAllVertices) {
      const rings = [poly.outer, ...poly.holes];
      for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri];
        const hi = ri === 0 ? -1 : ri - 1; // -1 = outer, 0+ = holes
        for (let vi = 0; vi < ring.length; vi++) {
          const p = ring[vi];
          const cp = worldToCanvas(p.x, p.y, vt);

          let color = COLORS.vertex;
          let half = 3;
          if (filletStatuses) {
            const st = filletStatuses.get(`${poly.id}_${hi}_${vi}`);
            if (st === 'hover')      { color = COLORS.vertexHover; half = 5; }
            else if (st === 'bad')   { color = COLORS.vertexBad; }
            else if (st === 'skip')  { color = COLORS.vertexSkip; }
          }

          ctx.fillStyle = color;
          ctx.fillRect(cp.x - half, cp.y - half, half * 2, half * 2);
        }
      }
    }

    ctx.globalAlpha = 1.0;
  }

  private tracePath(ring: Ring, vt: ViewTransform): void {
    if (ring.length === 0) return;
    const first = worldToCanvas(ring[0].x, ring[0].y, vt);
    this.ctx.moveTo(first.x, first.y);
    for (let i = 1; i < ring.length; i++) {
      const cp = worldToCanvas(ring[i].x, ring[i].y, vt);
      this.ctx.lineTo(cp.x, cp.y);
    }
    this.ctx.closePath();
  }

  private drawDraft(draft: DraftShape, vt: ViewTransform): void {
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.draftShape;
    ctx.fillStyle = COLORS.draftFill;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);

    const pts = draft.points;
    if (pts.length < 2) {
      ctx.setLineDash([]);
      return;
    }

    if (draft.type === 'rect' && pts.length >= 2) {
      const p1 = worldToCanvas(pts[0].x, pts[0].y, vt);
      const p2 = worldToCanvas(pts[1].x, pts[1].y, vt);
      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else if (draft.type === 'circle' && pts.length >= 2) {
      const center = worldToCanvas(pts[0].x, pts[0].y, vt);
      const edge = worldToCanvas(pts[1].x, pts[1].y, vt);
      const dx = edge.x - center.x;
      const dy = edge.y - center.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (draft.type === 'fillet-preview' && pts.length >= 3) {
      ctx.beginPath();
      const first = worldToCanvas(pts[0].x, pts[0].y, vt);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < pts.length; i++) {
        const cp = worldToCanvas(pts[i].x, pts[i].y, vt);
        ctx.lineTo(cp.x, cp.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (draft.type === 'polygon' && pts.length >= 1) {
      const invalid = draft.selfIntersects === true;
      const strokeColor = invalid ? COLORS.drcError : COLORS.draftShape;
      const fillColor = invalid ? 'rgba(243,139,168,0.1)' : COLORS.draftFill;
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = fillColor;

      // Draw committed edges as solid lines
      ctx.setLineDash([]);
      ctx.beginPath();
      const fp = worldToCanvas(pts[0].x, pts[0].y, vt);
      ctx.moveTo(fp.x, fp.y);
      for (let i = 1; i < pts.length - 1; i++) {
        const cp = worldToCanvas(pts[i].x, pts[i].y, vt);
        ctx.lineTo(cp.x, cp.y);
      }
      ctx.stroke();

      // Draw pending edge (last committed → hover) as dashed line
      if (pts.length >= 2) {
        ctx.setLineDash([4, 4]);
        const prev = worldToCanvas(pts[pts.length - 2].x, pts[pts.length - 2].y, vt);
        const cur  = worldToCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y, vt);
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
      }

      // Draw vertex dots for committed vertices (all but the trailing hover point)
      ctx.setLineDash([]);
      for (let i = 0; i < pts.length - 1; i++) {
        const cp = worldToCanvas(pts[i].x, pts[i].y, vt);
        const isFirst = i === 0;
        const closing = isFirst && draft.willClose === true;
        ctx.fillStyle = closing ? '#ffffff' : strokeColor;
        const r = (isFirst || closing) ? 5 : 3;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.fill();
        // White ring around first vertex when close-snap is active
        if (closing) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = strokeColor;
        }
      }
    } else if (draft.type === 'line' && pts.length >= 2) {
      const p1 = worldToCanvas(pts[0].x, pts[0].y, vt);
      const p2 = worldToCanvas(pts[1].x, pts[1].y, vt);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      // Endpoint dots
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.draftShape;
      for (const cp of [p1, p2]) {
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.setLineDash([]);
  }

  private drawTextPreview(polys: Polygon[], vt: ViewTransform): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COLORS.draftShape;
    ctx.fillStyle = 'rgba(100,200,100,0.12)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    for (const poly of polys) {
      ctx.beginPath();
      const o = poly.outer;
      const f = worldToCanvas(o[0].x, o[0].y, vt);
      ctx.moveTo(f.x, f.y);
      for (let i = 1; i < o.length; i++) {
        const cp = worldToCanvas(o[i].x, o[i].y, vt);
        ctx.lineTo(cp.x, cp.y);
      }
      ctx.closePath();
      for (const hole of poly.holes) {
        const fh = worldToCanvas(hole[0].x, hole[0].y, vt);
        ctx.moveTo(fh.x, fh.y);
        for (let i = 1; i < hole.length; i++) {
          const ch = worldToCanvas(hole[i].x, hole[i].y, vt);
          ctx.lineTo(ch.x, ch.y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDiffLabel(shape: Polygon, label: string, vt: ViewTransform): void {
    if (shape.outer.length === 0) return;
    const ctx = this.ctx;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of shape.outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const cp = worldToCanvas((minX + maxX) / 2, (minY + maxY) / 2, vt);
    ctx.save();
    ctx.font = 'bold 11px monospace';
    const tw = ctx.measureText(label).width;
    const padX = 6, padY = 4;
    ctx.fillStyle = 'rgba(74,158,255,0.85)';
    ctx.fillRect(cp.x - tw / 2 - padX, cp.y - 8 - padY, tw + padX * 2, 16 + padY * 2);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cp.x, cp.y);
    ctx.restore();
  }

  private drawDrcMarker(worldPt: Point, vt: ViewTransform): void {
    const cp = worldToCanvas(worldPt.x, worldPt.y, vt);
    const ctx = this.ctx;
    const r = 6;
    ctx.save();
    ctx.strokeStyle = COLORS.drcError;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cp.x - r, cp.y - r); ctx.lineTo(cp.x + r, cp.y + r);
    ctx.moveTo(cp.x + r, cp.y - r); ctx.lineTo(cp.x - r, cp.y + r);
    ctx.stroke();
    ctx.restore();
  }

  private drawRubberBand(start: { x: number; y: number }, end: { x: number; y: number }): void {
    const ctx = this.ctx;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    ctx.save();
    ctx.strokeStyle = 'rgba(100,200,255,0.9)';
    ctx.fillStyle = 'rgba(100,200,255,0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ─── Measure overlay ───────────────────────────────────────────────────────

  private drawMeasureOverlay(ov: MeasureOverlay, unit: 'mm' | 'um', vt: ViewTransform): void {
    const ctx = this.ctx;
    const c1 = worldToCanvas(ov.p1.x, ov.p1.y, vt);
    const c2 = worldToCanvas(ov.p2.x, ov.p2.y, vt);
    const color = '#00ffcc';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const mx = (c1.x + c2.x) / 2;
    const my = (c1.y + c2.y) / 2;
    const dx = Math.abs(ov.p2.x - ov.p1.x);
    const dy = Math.abs(ov.p2.y - ov.p1.y);
    const d = Math.round(Math.sqrt(dx * dx + dy * dy));
    const label = `dx=${UnitConverter.formatOutput(dx, unit, true)}  dy=${UnitConverter.formatOutput(dy, unit, true)}  d=${UnitConverter.formatOutput(d, unit, true)}`;

    ctx.font = 'bold 11px monospace';
    const tw = ctx.measureText(label).width;
    const padX = 6, padY = 3;
    ctx.fillStyle = 'rgba(0,30,24,0.82)';
    ctx.fillRect(mx - tw / 2 - padX, my - 9 - padY, tw + padX * 2, 18 + padY * 2);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my);
    ctx.restore();
  }

  private drawHud(hud: DrawHud, vt: ViewTransform): void {
    const ctx = this.ctx;
    const cp = worldToCanvas(hud.worldPt.x, hud.worldPt.y, vt);
    const color = 'rgba(100,200,100,0.95)';
    const label = hud.label;
    ctx.save();
    ctx.font = 'bold 11px monospace';
    const tw = ctx.measureText(label).width;
    const padX = 5, padY = 3;
    const bx = cp.x + 10;
    const by = cp.y + 10;
    ctx.fillStyle = 'rgba(0,20,10,0.82)';
    ctx.fillRect(bx - padX, by - 9 - padY, tw + padX * 2, 18 + padY * 2);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by);
    ctx.restore();
  }

  // ─── Dimension rendering ───────────────────────────────────────────────────

  private static readonly DIM_ARROW = 8;
  private static readonly DIM_ANGLE = Math.PI / 6;
  private static readonly DIM_EXT_GAP = 4;
  private static readonly DIM_EXT_OVER = 5;
  private static readonly DIM_TEXT_GAP = 7;

  private drawDimensions(
    dimensions: Dimension[],
    shapes: Polygon[],
    layerMap: Map<string, Layer>,
    selectedIds: Set<string>,
    unit: 'mm' | 'um',
    vt: ViewTransform,
  ): void {
    for (const dim of dimensions) {
      const layer = layerMap.get(dim.layer);
      if (layer && !layer.visible) continue;
      const selected = selectedIds.has(dim.id);
      const { p1, p2, frozen } = resolveDimension(dim, shapes);
      const baseColor = selected ? COLORS.shapeSelected : (layer?.color ?? '#888888');
      const color = frozen ? '#7a7a8a' : baseColor;
      this.drawOneDimension(dim.kind, p1, p2, dim.offset, color, unit, vt, frozen);
    }
  }

  private drawOneDimension(
    kind: Dimension['kind'],
    p1: Point,
    p2: Point,
    offset: number,
    color: string,
    unit: 'mm' | 'um',
    vt: ViewTransform,
    frozen = false,
  ): void {
    const ctx = this.ctx;
    const { DIM_ARROW, DIM_ANGLE, DIM_EXT_GAP, DIM_EXT_OVER, DIM_TEXT_GAP } = CanvasRenderer;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = frozen ? 0.6 : 0.8;
    ctx.setLineDash([]);

    if (kind === 'centerline') {
      const c1 = worldToCanvas(p1.x, p1.y, vt);
      const c2 = worldToCanvas(p2.x, p2.y, vt);
      ctx.setLineDash([12, 3, 2, 3]);
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (kind === 'arrow') {
      const c1 = worldToCanvas(p1.x, p1.y, vt);
      const c2 = worldToCanvas(p2.x, p2.y, vt);
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
      
      const angle = Math.atan2(c2.y - c1.y, c2.x - c1.x);
      // Arrow points towards p2, so the arrowhead is at p2 pointing towards p1 (angle + PI)
      this.drawArrowhead(c2.x, c2.y, angle + Math.PI, DIM_ARROW, DIM_ANGLE);
      ctx.restore();
      return;
    }

    if (kind === 'linear-h') {
      const c1 = worldToCanvas(p1.x, p1.y, vt);
      const c2 = worldToCanvas(p2.x, p2.y, vt);
      const cdy = worldToCanvas(0, offset, vt).y;

      const d1 = Math.sign(cdy - c1.y) || 1;
      const d2 = Math.sign(cdy - c2.y) || 1;
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y + DIM_EXT_GAP * d1);
      ctx.lineTo(c1.x, cdy + DIM_EXT_OVER * d1);
      ctx.moveTo(c2.x, c2.y + DIM_EXT_GAP * d2);
      ctx.lineTo(c2.x, cdy + DIM_EXT_OVER * d2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(c1.x, cdy);
      ctx.lineTo(c2.x, cdy);
      ctx.stroke();

      const dirX = Math.sign(c2.x - c1.x);
      this.drawArrowhead(c1.x, cdy, dirX > 0 ? 0 : Math.PI, DIM_ARROW, DIM_ANGLE);
      this.drawArrowhead(c2.x, cdy, dirX > 0 ? Math.PI : 0, DIM_ARROW, DIM_ANGLE);

      const label = UnitConverter.formatOutput(Math.abs(p2.x - p1.x), unit, true);
      const textDir = -(d1 || 1);
      this.drawDimLabel(label, (c1.x + c2.x) / 2, cdy + DIM_TEXT_GAP * textDir);
    } else {
      // linear-v
      const c1 = worldToCanvas(p1.x, p1.y, vt);
      const c2 = worldToCanvas(p2.x, p2.y, vt);
      const cdx = worldToCanvas(offset, 0, vt).x;

      const d1 = Math.sign(cdx - c1.x) || 1;
      const d2 = Math.sign(cdx - c2.x) || 1;
      ctx.beginPath();
      ctx.moveTo(c1.x + DIM_EXT_GAP * d1, c1.y);
      ctx.lineTo(cdx + DIM_EXT_OVER * d1, c1.y);
      ctx.moveTo(c2.x + DIM_EXT_GAP * d2, c2.y);
      ctx.lineTo(cdx + DIM_EXT_OVER * d2, c2.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cdx, c1.y);
      ctx.lineTo(cdx, c2.y);
      ctx.stroke();

      const dirY = Math.sign(c2.y - c1.y);
      this.drawArrowhead(cdx, c1.y, dirY > 0 ? Math.PI / 2 : -Math.PI / 2, DIM_ARROW, DIM_ANGLE);
      this.drawArrowhead(cdx, c2.y, dirY > 0 ? -Math.PI / 2 : Math.PI / 2, DIM_ARROW, DIM_ANGLE);

      const label = UnitConverter.formatOutput(Math.abs(p2.y - p1.y), unit, true);
      const textDir = -(d1 || 1);
      ctx.save();
      ctx.translate(cdx + DIM_TEXT_GAP * textDir * 3 + (textDir < 0 ? -2 : 2), (c1.y + c2.y) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.font = '10px monospace';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  private drawArrowhead(x: number, y: number, angle: number, size: number, half: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + size * Math.cos(angle + half), y + size * Math.sin(angle + half));
    ctx.moveTo(x, y);
    ctx.lineTo(x + size * Math.cos(angle - half), y + size * Math.sin(angle - half));
    ctx.stroke();
  }

  private drawDimLabel(text: string, cx: number, cy: number): void {
    const ctx = this.ctx;
    ctx.font = '10px monospace';
    const tw = ctx.measureText(text).width;
    const padX = 3, padY = 2;
    const bg = this.isDark ? 'rgba(30,30,46,0.85)' : 'rgba(245,245,240,0.85)';
    ctx.fillStyle = bg;
    ctx.fillRect(cx - tw / 2 - padX, cy - 6 - padY, tw + padX * 2, 12 + padY * 2);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy);
  }

  // ─── In-progress drafts ────────────────────────────────────────────────────

  private drawDimDraft(draft: DimDraft, vt: ViewTransform): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(100,200,100,0.7)';
    ctx.fillStyle = 'rgba(100,200,100,0.7)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);

    const c1 = worldToCanvas(draft.p1.x, draft.p1.y, vt);

    if (!draft.p2) { ctx.restore(); return; }
    const c2 = worldToCanvas(draft.p2.x, draft.p2.y, vt);
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.stroke();

    if (draft.kind === 'centerline' || draft.kind === 'arrow') {
      ctx.restore();
      // Use mm for dimension draft by default as it's just a preview, or pass proper unit if possible.
      // Since it's a draft, we'll use mm.
      this.drawOneDimension(draft.kind, draft.p1, draft.p2, 0, 'rgba(100,200,100,0.7)', 'mm', vt);
      return;
    }

    if (draft.kind === undefined || draft.offset === undefined) { ctx.restore(); return; }

    ctx.setLineDash([]);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(100,200,100,0.7)';
    ctx.fillStyle = 'rgba(100,200,100,0.7)';
    ctx.lineWidth = 1.2;
    this.drawOneDimension(draft.kind, draft.p1, draft.p2, draft.offset, 'rgba(100,200,100,0.7)', 'mm', vt);
    ctx.restore();
  }

  // ─── Annotation rendering ──────────────────────────────────────────────────

  private static readonly ANNOTATION_FONT = '"Noto Sans JP", Meiryo, "Yu Gothic", "MS Gothic", sans-serif';

  private drawAnnotations(
    annotations: Annotation[],
    layerMap: Map<string, Layer>,
    selectedIds: Set<string>,
    vt: ViewTransform,
  ): void {
    const ctx = this.ctx;
    for (const ann of annotations) {
      if (!ann.text.trim()) continue;
      const layer = layerMap.get(ann.layer);
      if (layer && !layer.visible) continue;

      const isSelected = selectedIds.has(ann.id);
      const color = isSelected ? COLORS.shapeSelected : (layer?.color ?? '#aabbdd');
      const cp = worldToCanvas(ann.origin.x, ann.origin.y, vt);
      const sizePx = Math.max(6, ann.heightUm * vt.zoom);
      const lineHeightPx = sizePx * 1.2;
      const lines = ann.text.split('\n');

      ctx.save();
      ctx.globalAlpha = layer?.locked ? 0.5 : 1.0;
      ctx.font = `${sizePx}px ${CanvasRenderer.ANNOTATION_FONT}`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.setLineDash([]);

      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], cp.x, cp.y + i * lineHeightPx);
      }

      if (isSelected) {
        const maxWidth = Math.max(...lines.map((l) => ctx.measureText(l).width), 20);
        const totalHeight = lines.length * lineHeightPx;
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(cp.x - 2, cp.y - 2, maxWidth + 4, totalHeight + 4);
        ctx.setLineDash([]);
      }

      ctx.restore();
    }
  }

  private drawAnnotationPreview(pt: Point, vt: ViewTransform): void {
    const ctx = this.ctx;
    const cp = worldToCanvas(pt.x, pt.y, vt);
    ctx.save();
    ctx.strokeStyle = 'rgba(100,200,100,0.7)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cp.x - 6, cp.y);
    ctx.lineTo(cp.x + 6, cp.y);
    ctx.moveTo(cp.x, cp.y - 6);
    ctx.lineTo(cp.x, cp.y + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawRulers(_state: AppState, vt: ViewTransform): void {
    const ctx = this.ctx;
    const bg = this.isDark ? COLORS.ruler : COLORS.rulerLight;
    const textColor = this.isDark ? COLORS.rulerText : COLORS.rulerTextLight;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, RULER_SIZE, this.height);
    ctx.fillRect(0, 0, this.width, RULER_SIZE);

    // Corner square
    ctx.fillStyle = this.isDark ? '#333344' : '#d0d0e0';
    ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);

    ctx.strokeStyle = textColor;
    ctx.lineWidth = 0.5;

    const worldLeft = (RULER_SIZE - vt.panX) / vt.zoom;
    const worldRight = (this.width - vt.panX) / vt.zoom;
    const worldTop = (RULER_SIZE - vt.panY) / vt.zoom;
    const worldBottom = (this.height - vt.panY) / vt.zoom;

    // Major tick step: aim for ~70px per major tick
    const targetPx = 70;
    const rawStep = targetPx / vt.zoom;
    const exp = Math.floor(Math.log10(rawStep));
    const nice = [1, 2, 5, 10];
    let step = Math.pow(10, exp);
    for (const n of nice) {
      const s = n * Math.pow(10, exp);
      if (s * vt.zoom >= targetPx) { step = s; break; }
    }

    // Minor ticks: step / 5, only when ≥ 8px apart
    const subDiv = 5;
    const subStep = step / subDiv;
    const showMinor = subStep * vt.zoom >= 8;

    const unit = _state.displayUnit;
    const formatLabel = (w: number) => {
      if (unit === 'mm') {
        const val = w / 1000;
        // Optimization: show integer mm if possible to save space on ruler
        return (val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)) + 'mm';
      } else {
        return Math.round(w) + 'µ';
      }
    };

    // Horizontal ruler (top)
    ctx.font = '9px monospace';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const hStartI = Math.floor(worldLeft / subStep);
    for (let i = hStartI; i * subStep <= worldRight; i++) {
      const wx = i * subStep;
      const cx = wx * vt.zoom + vt.panX;
      if (cx < RULER_SIZE) continue;
      const isMajor = i % subDiv === 0;
      if (!isMajor && !showMinor) continue;
      const tickH = isMajor ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(cx, RULER_SIZE - tickH);
      ctx.lineTo(cx, RULER_SIZE);
      ctx.stroke();
      if (isMajor) ctx.fillText(formatLabel(wx), cx + 2, RULER_SIZE - 8);
    }

    // Vertical ruler (left) — tick marks + per-label rotation
    // After translate(tx, ty) + rotate(-PI/2): local(rx,ry) → screen(tx+ry, ty-rx)
    // Using textAlign='center', textBaseline='middle' at translate(RULER_SIZE/2, cy):
    //   label center → screen (RULER_SIZE/2, cy); text runs vertically ±width/2 around cy
    const vStartI = Math.floor(worldTop / subStep);
    for (let i = vStartI; i * subStep <= worldBottom; i++) {
      const wy = i * subStep;
      const cy = wy * vt.zoom + vt.panY;
      if (cy < RULER_SIZE) continue;
      const isMajor = i % subDiv === 0;
      if (!isMajor && !showMinor) continue;
      const tickW = isMajor ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(RULER_SIZE - tickW, cy);
      ctx.lineTo(RULER_SIZE, cy);
      ctx.stroke();
      if (isMajor) {
        ctx.save();
        ctx.font = '8px monospace';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(RULER_SIZE / 2, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(formatLabel(wy), 0, 0);
        ctx.restore();
      }
    }
  }
}
