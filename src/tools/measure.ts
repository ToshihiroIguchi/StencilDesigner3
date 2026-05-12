import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { MeasureOverlay } from '../canvas/renderer';
import { constrainAngle } from '../core/geometry';

export class MeasureTool extends BaseTool {
  private p1: Point | null = null;

  private static readonly ANGLE_SNAP_DEG = 45;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.p1 = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    let snapped = this.ctx.getSnapPoint(worldPt);
    if (shift && this.p1) {
      snapped = constrainAngle(this.p1, snapped, MeasureTool.ANGLE_SNAP_DEG);
    }
    this.snapPoint = snapped;
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
