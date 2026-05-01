import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { rectToPolygon } from '../core/geometry';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/autosave';

export class RectTool extends BaseTool {
  private startPt: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    this.startPt = { ...snapped };
    this.draft = { type: 'rect', points: [snapped, snapped] };
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    if (!this.startPt) return;
    const snapped = this.ctx.getSnapPoint(worldPt);

    let dx = snapped.x - this.startPt.x;
    let dy = snapped.y - this.startPt.y;

    if (shift) {
      // Square constraint
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx) * size;
      dy = Math.sign(dy) * size;
    }

    const end = { x: this.startPt.x + dx, y: this.startPt.y + dy };
    this.draft = { type: 'rect', points: [this.startPt, end] };
    this.snapPoint = snapped;
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    if (!this.startPt) return;
    const snapped = this.ctx.getSnapPoint(worldPt);

    let dx = snapped.x - this.startPt.x;
    let dy = snapped.y - this.startPt.y;

    if (shift) {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx) * size;
      dy = Math.sign(dy) * size;
    }

    const x2 = this.startPt.x + dx;
    const y2 = this.startPt.y + dy;

    if (Math.abs(dx) >= 1 && Math.abs(dy) >= 1) {
      try {
        const poly = rectToPolygon(this.startPt.x, this.startPt.y, x2, y2);
        this.ctx.history.execute(new AddShapeCommand(poly));
        markDirty();
      } catch {
        // Degenerate rect
      }
    }

    this.startPt = null;
    this.draft = null;
    this.snapPoint = null;
    this.ctx.requestRender();
  }
}
