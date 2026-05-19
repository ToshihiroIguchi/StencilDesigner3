import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { circleToPolygon } from '../core/geometry';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { UnitConverter } from '../core/format';

const DRAG_THRESHOLD_PX = 5;

export class CircleTool extends BaseTool {
  private centerPt: Point | null = null;
  private dragStartCanvas: Point | null = null;
  private dragThresholdReached = false;

  private placeX: number = 0;
  private placeY: number = 0;
  private diameterUm: number = 5000;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  getPlaceX(): number { return this.placeX; }
  getPlaceY(): number { return this.placeY; }
  getDiameter(): number { return this.diameterUm; }
  setPlaceX(x: number): void { this.placeX = Math.round(x); }
  setPlaceY(y: number): void { this.placeY = Math.round(y); }
  setDiameter(d: number): void { if (d >= 1) this.diameterUm = Math.round(d); }

  /** Place circle using panel X/Y/D values (no canvas click needed). */
  placeFromPanel(state: AppState): void {
    const r = Math.round(this.diameterUm / 2);
    if (r < 1) return;
    try {
      const poly = circleToPolygon(this.placeX, this.placeY, r, undefined, state.activeLayerName);
      this.ctx.history.execute(new AddShapeCommand(poly));
      markDirty();
    } catch {
      // Degenerate circle
    }
    this.ctx.requestRender();
  }

  onMouseDown(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snap = this.ctx.getSnap(worldPt);
    this.centerPt = { ...snap.point };
    this.dragStartCanvas = { ...canvasPt };
    this.dragThresholdReached = false;
    this.draft = null;
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    if (!this.centerPt || !this.dragStartCanvas) return;

    if (!this.dragThresholdReached) {
      const dxPx = canvasPt.x - this.dragStartCanvas.x;
      const dyPx = canvasPt.y - this.dragStartCanvas.y;
      if (Math.sqrt(dxPx * dxPx + dyPx * dyPx) > DRAG_THRESHOLD_PX) {
        this.dragThresholdReached = true;
      }
    }

    if (this.dragThresholdReached) {
      const snap = this.ctx.getSnap(worldPt);
      this.draft = { type: 'circle', points: [this.centerPt, snap.point] };
      this.snap = snap;
    }

    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    if (!this.centerPt) return;

    if (this.dragThresholdReached) {
      // Drag mode: commit with drag radius, update stored diameter and center
      const snap = this.ctx.getSnap(worldPt);
      const dx = snap.point.x - this.centerPt.x;
      const dy = snap.point.y - this.centerPt.y;
      const r = Math.round(Math.sqrt(dx * dx + dy * dy));

      if (r >= 1) {
        try {
          const poly = circleToPolygon(this.centerPt.x, this.centerPt.y, r, undefined, state.activeLayerName);
          this.ctx.history.execute(new AddShapeCommand(poly));
          this.placeX = this.centerPt.x;
          this.placeY = this.centerPt.y;
          this.diameterUm = r * 2;
          markDirty();
        } catch {
          // Degenerate circle
        }
      }
    } else {
      // Click mode: place circle at click point with stored diameter, update stored center
      this.placeX = this.centerPt.x;
      this.placeY = this.centerPt.y;
      const r = Math.round(this.diameterUm / 2);
      if (r >= 1) {
        try {
          const poly = circleToPolygon(this.placeX, this.placeY, r, undefined, state.activeLayerName);
          this.ctx.history.execute(new AddShapeCommand(poly));
          markDirty();
        } catch {
          // Degenerate circle
        }
      }
    }

    this.centerPt = null;
    this.dragStartCanvas = null;
    this.dragThresholdReached = false;
    this.draft = null;
    this.snap = null;
    this.ctx.requestRender();
  }

  /** Returns HUD label and canvas position for overlay during drag. */
  getDrawHud(unit: 'mm' | 'um'): { label: string; worldPt: Point } | null {
    if (!this.dragThresholdReached || !this.draft) return null;
    const [center, edge] = this.draft.points;
    const dx = edge.x - center.x;
    const dy = edge.y - center.y;
    const r = Math.round(Math.sqrt(dx * dx + dy * dy));
    return {
      label: `Ø ${UnitConverter.formatOutput(r * 2, unit, true)}`,
      worldPt: edge,
    };
  }
}
