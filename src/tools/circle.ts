import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { circleToPolygon } from '../core/geometry';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/autosave';

export class CircleTool extends BaseTool {
  private centerPt: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    this.centerPt = { ...snapped };
    this.draft = { type: 'circle', points: [snapped, snapped] };
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    if (!this.centerPt) return;
    const snapped = this.ctx.getSnapPoint(worldPt);
    this.draft = { type: 'circle', points: [this.centerPt, snapped] };
    this.snapPoint = snapped;
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    if (!this.centerPt) return;
    const snapped = this.ctx.getSnapPoint(worldPt);

    const dx = snapped.x - this.centerPt.x;
    const dy = snapped.y - this.centerPt.y;
    const r = Math.round(Math.sqrt(dx * dx + dy * dy));

    if (r >= 1) {
      try {
        const poly = circleToPolygon(this.centerPt.x, this.centerPt.y, r);
        this.ctx.history.execute(new AddShapeCommand(poly));
        markDirty();
      } catch {
        // Degenerate circle
      }
    }

    this.centerPt = null;
    this.draft = null;
    this.snapPoint = null;
    this.ctx.requestRender();
  }
}
