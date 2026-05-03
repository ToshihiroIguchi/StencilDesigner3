import type { AppState, DrcError, Point, Polygon, Ring, ViewTransform } from '../types';
import { worldToCanvas } from '../types';
import { selectedIds } from '../core/transform';

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
  type: 'rect' | 'circle' | 'fillet-preview';
  points: { x: number; y: number }[]; // world coordinates
}

export type FilletVertexStatus = 'ok' | 'skip' | 'bad' | 'hover';

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
    snapPt?: { x: number; y: number },
    showAllVertices = false,
    rubberBand?: { start: { x: number; y: number }; end: { x: number; y: number } },
    filletStatuses?: Map<string, FilletVertexStatus>,
    drcErrors?: DrcError[],
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
    for (const shape of state.shapes) {
      this.drawPolygon(shape, selIds.has(shape.id), vt, showAllVertices, filletStatuses, drcErrorIds.has(shape.id));
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

    // Snap indicator
    if (snapPt && state.snapEnabled) {
      const cp = worldToCanvas(snapPt.x, snapPt.y, vt);
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.snapIndicator;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Rubber-band selection rectangle
    if (rubberBand) {
      this.drawRubberBand(rubberBand.start, rubberBand.end);
    }

    ctx.restore();

    // Rulers (drawn on top, outside clip)
    this.drawRulers(state, vt);
  }

  private drawGrid(state: AppState, vt: ViewTransform): void {
    const ctx = this.ctx;
    const gridColor = this.isDark ? COLORS.grid : COLORS.gridLight;
    const gs = state.gridSize; // µm

    const worldLeft = (RULER_SIZE - vt.panX) / vt.zoom;
    const worldTop = (RULER_SIZE - vt.panY) / vt.zoom;
    const worldRight = (this.width - vt.panX) / vt.zoom;
    const worldBottom = (this.height - vt.panY) / vt.zoom;

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
  ): void {
    const ctx = this.ctx;
    const strokeColor = selected ? COLORS.shapeSelected : COLORS.shape;
    const fillColor = selected ? COLORS.shapeFillSelected : COLORS.shapeFill;
    ctx.lineWidth = 1;

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
    }

    ctx.setLineDash([]);
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

  private drawRulers(_state: AppState, vt: ViewTransform): void {
    const ctx = this.ctx;
    const bg = this.isDark ? COLORS.ruler : COLORS.rulerLight;
    const textColor = this.isDark ? COLORS.rulerText : COLORS.rulerTextLight;
    const lineColor = textColor;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, RULER_SIZE, this.height);
    ctx.fillRect(0, 0, this.width, RULER_SIZE);

    // Corner square
    ctx.fillStyle = this.isDark ? '#333344' : '#d0d0e0';
    ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);

    ctx.font = '9px monospace';
    ctx.fillStyle = textColor;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 0.5;

    const worldLeft = (RULER_SIZE - vt.panX) / vt.zoom;
    const worldRight = (this.width - vt.panX) / vt.zoom;
    const worldTop = (RULER_SIZE - vt.panY) / vt.zoom;
    const worldBottom = (this.height - vt.panY) / vt.zoom;

    // Determine tick step: aim for ~60-80px per tick
    const targetPx = 70;
    const rawStep = targetPx / vt.zoom;
    const exp = Math.floor(Math.log10(rawStep));
    const nice = [1, 2, 5, 10];
    let step = Math.pow(10, exp);
    for (const n of nice) {
      const s = n * Math.pow(10, exp);
      if (s * vt.zoom >= targetPx) { step = s; break; }
    }

    // Horizontal ruler
    for (let wx = Math.floor(worldLeft / step) * step; wx <= worldRight; wx += step) {
      const cx = wx * vt.zoom + vt.panX;
      if (cx < RULER_SIZE) continue;
      ctx.beginPath();
      ctx.moveTo(cx, RULER_SIZE - 6);
      ctx.lineTo(cx, RULER_SIZE);
      ctx.stroke();
      const label = wx >= 1000 ? `${(wx / 1000).toFixed(wx % 1000 === 0 ? 0 : 1)}mm` : `${wx}µ`;
      ctx.fillText(label, cx + 2, RULER_SIZE - 8);
    }

    // Vertical ruler
    ctx.save();
    ctx.translate(RULER_SIZE, 0);
    ctx.rotate(Math.PI / 2);
    for (let wy = Math.floor(worldTop / step) * step; wy <= worldBottom; wy += step) {
      const cy = wy * vt.zoom + vt.panY;
      if (cy < RULER_SIZE) continue;
      ctx.beginPath();
      ctx.moveTo(cy - this.height, RULER_SIZE - 6);
      ctx.lineTo(cy - this.height, RULER_SIZE);
      ctx.stroke();
      const label = wy >= 1000 ? `${(wy / 1000).toFixed(wy % 1000 === 0 ? 0 : 1)}mm` : `${wy}µ`;
      ctx.fillText(label, cy - this.height + 2, RULER_SIZE - 8);
    }
    ctx.restore();
  }
}
