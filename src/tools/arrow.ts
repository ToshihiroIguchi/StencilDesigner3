import type { AppState, Point, Dimension, DimensionAnchor } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import { constrainAngle } from '../core/geometry';
import { AddDimensionCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { snapToDimensionAnchor } from '../core/anchor-from-snap';

export class ArrowTool extends BaseTool {
  private p1: Point | null = null;
  private anchor1: DimensionAnchor | null = null;

  private static readonly ANGLE_SNAP_DEG = 45;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    this.p1 = s.point;
    this.anchor1 = snapToDimensionAnchor(s);
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    if (shift && this.p1) {
      this.snap = { ...s, point: constrainAngle(this.p1, s.point, ArrowTool.ANGLE_SNAP_DEG) };
    } else {
      this.snap = s;
    }
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    if (!this.p1 || !this.anchor1) {
      this.cancel();
      return;
    }

    const s = this.ctx.getSnap(worldPt);
    const pt = (shift && this.p1)
      ? constrainAngle(this.p1, s.point, ArrowTool.ANGLE_SNAP_DEG)
      : s.point;
    const anchor2 = snapToDimensionAnchor({ ...s, point: pt });

    if (this.p1.x === pt.x && this.p1.y === pt.y) {
      this.cancel();
      return;
    }

    const dim: Dimension = {
      id: newId(),
      kind: 'arrow',
      anchor1: this.anchor1,
      anchor2,
      offset: 0,
      layer: 'DIMENSIONS',
      frozen: false,
    };

    this.ctx.history.execute(new AddDimensionCommand(dim));
    markDirty();
    this.cancel();
  }

  override onKeyDown(key: string, _state: AppState): void {
    if (key === 'Escape') {
      this.cancel();
    }
  }

  getRendererExtras() {
    if (!this.p1 || !this.snap) return {};
    return {
      dimDraft: {
        p1: this.p1,
        p2: this.snap.point,
        kind: 'arrow' as const,
        offset: 0,
      },
    };
  }

  override cancel(): void {
    this.p1 = null;
    this.anchor1 = null;
    super.cancel();
  }
}
