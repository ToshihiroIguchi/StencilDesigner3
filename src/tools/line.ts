import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { lineToPolygon } from '../core/geometry';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/autosave';

export class LineTool extends BaseTool {
  private startPt: Point | null = null;
  static readonly DEFAULT_WIDTH = 100; // µm

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    this.startPt = { ...snapped };
    this.draft = { type: 'line', points: [snapped, snapped] };
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    if (!this.startPt) return;
    const snapped = this.ctx.getSnapPoint(worldPt);

    let dx = snapped.x - this.startPt.x;
    let dy = snapped.y - this.startPt.y;

    // Shift constraint: snap to 0° or 90°
    if (shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    const end = { x: this.startPt.x + dx, y: this.startPt.y + dy };
    this.draft = { type: 'line', points: [this.startPt, end] };
    this.snapPoint = snapped;
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    if (!this.startPt) return;
    const snapped = this.ctx.getSnapPoint(worldPt);

    let dx = snapped.x - this.startPt.x;
    let dy = snapped.y - this.startPt.y;

    if (shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    const x2 = this.startPt.x + dx;
    const y2 = this.startPt.y + dy;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len >= 1) {
      try {
        const poly = lineToPolygon(this.startPt.x, this.startPt.y, x2, y2, LineTool.DEFAULT_WIDTH);
        this.ctx.history.execute(new AddShapeCommand(poly));
        markDirty();
      } catch {
        // Degenerate line
      }
    }

    this.startPt = null;
    this.draft = null;
    this.snapPoint = null;
    this.ctx.requestRender();
  }
}
