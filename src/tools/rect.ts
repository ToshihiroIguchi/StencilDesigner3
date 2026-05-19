import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { rectToPolygon } from '../core/geometry';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { UnitConverter } from '../core/format';

const DRAG_THRESHOLD_PX = 5;

export class RectTool extends BaseTool {
  private startPt: Point | null = null;
  private dragStartCanvas: Point | null = null;
  private dragThresholdReached = false;

  private placeX: number = 0;
  private placeY: number = 0;
  private widthUm: number = 10000;
  private heightUm: number = 10000;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  getPlaceX(): number { return this.placeX; }
  getPlaceY(): number { return this.placeY; }
  getWidth(): number { return this.widthUm; }
  getHeight(): number { return this.heightUm; }
  setPlaceX(x: number): void { this.placeX = Math.round(x); }
  setPlaceY(y: number): void { this.placeY = Math.round(y); }
  setWidth(w: number): void { if (w >= 1) this.widthUm = Math.round(w); }
  setHeight(h: number): void { if (h >= 1) this.heightUm = Math.round(h); }

  /** Place rect using panel X/Y/W/H values (no canvas click needed). */
  placeFromPanel(state: AppState): void {
    const x1 = this.placeX;
    const y1 = this.placeY;
    const x2 = x1 + this.widthUm;
    const y2 = y1 + this.heightUm;
    try {
      const poly = rectToPolygon(x1, y1, x2, y2, state.activeLayerName);
      this.ctx.history.execute(new AddShapeCommand(poly));
      markDirty();
    } catch {
      // Degenerate rect
    }
    this.ctx.requestRender();
  }

  onMouseDown(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snap = this.ctx.getSnap(worldPt);
    this.startPt = { ...snap.point };
    this.dragStartCanvas = { ...canvasPt };
    this.dragThresholdReached = false;
    this.draft = null;
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, canvasPt: Point, shift: boolean, _state: AppState): void {
    if (!this.startPt || !this.dragStartCanvas) return;

    if (!this.dragThresholdReached) {
      const dxPx = canvasPt.x - this.dragStartCanvas.x;
      const dyPx = canvasPt.y - this.dragStartCanvas.y;
      if (Math.sqrt(dxPx * dxPx + dyPx * dyPx) > DRAG_THRESHOLD_PX) {
        this.dragThresholdReached = true;
      }
    }

    if (this.dragThresholdReached) {
      const snap = this.ctx.getSnap(worldPt);
      let dx = snap.point.x - this.startPt.x;
      let dy = snap.point.y - this.startPt.y;

      if (shift) {
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * size;
        dy = Math.sign(dy) * size;
      }

      const end = { x: this.startPt.x + dx, y: this.startPt.y + dy };
      this.draft = { type: 'rect', points: [this.startPt, end] };
      this.snap = snap;
    }

    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, shift: boolean, state: AppState): void {
    if (!this.startPt) return;

    if (this.dragThresholdReached) {
      // Drag mode: commit with drag rect, update stored W/H and position
      const snap = this.ctx.getSnap(worldPt);
      let dx = snap.point.x - this.startPt.x;
      let dy = snap.point.y - this.startPt.y;

      if (shift) {
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * size;
        dy = Math.sign(dy) * size;
      }

      const x2 = this.startPt.x + dx;
      const y2 = this.startPt.y + dy;

      if (Math.abs(dx) >= 1 && Math.abs(dy) >= 1) {
        try {
          const poly = rectToPolygon(this.startPt.x, this.startPt.y, x2, y2, state.activeLayerName);
          this.ctx.history.execute(new AddShapeCommand(poly));
          // Update position to top-left of drawn rect
          this.placeX = Math.min(this.startPt.x, x2);
          this.placeY = Math.min(this.startPt.y, y2);
          this.widthUm = Math.abs(dx);
          this.heightUm = Math.abs(dy);
          markDirty();
        } catch {
          // Degenerate rect
        }
      }
    } else {
      // Click mode: place rect at click point with stored W/H, update stored X/Y
      this.placeX = this.startPt.x;
      this.placeY = this.startPt.y;
      const x2 = this.placeX + this.widthUm;
      const y2 = this.placeY + this.heightUm;
      try {
        const poly = rectToPolygon(this.placeX, this.placeY, x2, y2, state.activeLayerName);
        this.ctx.history.execute(new AddShapeCommand(poly));
        markDirty();
      } catch {
        // Degenerate rect
      }
    }

    this.startPt = null;
    this.dragStartCanvas = null;
    this.dragThresholdReached = false;
    this.draft = null;
    this.snap = null;
    this.ctx.requestRender();
  }

  /** Returns HUD label and world position for canvas overlay during drag. */
  getDrawHud(unit: 'mm' | 'um'): { label: string; worldPt: Point } | null {
    if (!this.dragThresholdReached || !this.draft) return null;
    const [p1, p2] = this.draft.points;
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    return {
      label: `${UnitConverter.formatOutput(w, unit, true)} × ${UnitConverter.formatOutput(h, unit, true)}`,
      worldPt: p2,
    };
  }
}
