import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { MeasureOverlay } from '../canvas/renderer';

export class MeasureTool extends BaseTool {
  private p1: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.p1 = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  getMeasureOverlay(): MeasureOverlay | null {
    if (!this.p1 || !this.snapPoint) return null;
    return { p1: this.p1, p2: this.snapPoint };
  }

  getP1(): Point | null { return this.p1; }

  override cancel(): void {
    this.p1 = null;
    super.cancel();
  }
}
