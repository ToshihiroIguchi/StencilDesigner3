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
    this.p1 = this.ctx.getSnap(worldPt).point;
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    const pt = (shift && this.p1)
      ? constrainAngle(this.p1, s.point, MeasureTool.ANGLE_SNAP_DEG)
      : s.point;
    this.snap = { ...s, point: pt };
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  getMeasureOverlay(): MeasureOverlay | null {
    if (!this.p1 || !this.snap) return null;
    return { p1: this.p1, p2: this.snap.point };
  }

  getP1(): Point | null { return this.p1; }

  override cancel(): void {
    this.p1 = null;
    super.cancel();
  }
}
