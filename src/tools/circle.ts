import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { circleToPolygon } from '../core/geometry';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/docStore';

export class CircleTool extends BaseTool {
  private centerPt: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snap = this.ctx.getSnap(worldPt);
    this.centerPt = { ...snap.point };
    this.draft = { type: 'circle', points: [snap.point, snap.point] };
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    if (!this.centerPt) return;
    const snap = this.ctx.getSnap(worldPt);
    this.draft = { type: 'circle', points: [this.centerPt, snap.point] };
    this.snap = snap;
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    if (!this.centerPt) return;
    const snap = this.ctx.getSnap(worldPt);

    const dx = snap.point.x - this.centerPt.x;
    const dy = snap.point.y - this.centerPt.y;
    const r = Math.round(Math.sqrt(dx * dx + dy * dy));

    if (r >= 1) {
      try {
        const poly = circleToPolygon(this.centerPt.x, this.centerPt.y, r, undefined, state.activeLayerName);
        this.ctx.history.execute(new AddShapeCommand(poly));
        markDirty();
      } catch {
        // Degenerate circle
      }
    }

    this.centerPt = null;
    this.draft = null;
    this.snap = null;
    this.ctx.requestRender();
  }
}
