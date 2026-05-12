import type { AppState, Point, Dimension, DimensionAnchor } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import { constrainAngle } from '../core/geometry';
import { AddDimensionCommand } from '../state/commands';
import { markDirty } from '../state/autosave';
import { findVertexAnchor } from '../core/anchor-pick';

export class ArrowTool extends BaseTool {
  private p1: Point | null = null;
  private anchor1: DimensionAnchor | null = null;

  private static readonly ANGLE_SNAP_DEG = 45;
  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    const worldRadius = state.snapRadius / state.zoom;
    
    const va = findVertexAnchor(snapped, state.shapes, worldRadius);
    const anchor = va ?? { kind: 'free', point: snapped };

    this.p1 = snapped;
    this.anchor1 = anchor;
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    let snapped = this.ctx.getSnapPoint(worldPt);
    if (shift && this.p1) {
      snapped = constrainAngle(this.p1, snapped, ArrowTool.ANGLE_SNAP_DEG);
    }
    this.snapPoint = snapped;
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, shift: boolean, state: AppState): void {
    if (!this.p1 || !this.anchor1) {
      this.cancel();
      return;
    }

    let snapped = this.ctx.getSnapPoint(worldPt);
    if (shift && this.p1) {
      snapped = constrainAngle(this.p1, snapped, ArrowTool.ANGLE_SNAP_DEG);
    }
    const worldRadius = state.snapRadius / state.zoom;
    const va = findVertexAnchor(snapped, state.shapes, worldRadius);
    const anchor2 = va ?? { kind: 'free', point: snapped };

    if (this.p1.x === snapped.x && this.p1.y === snapped.y) {
      this.cancel();
      return; // ignore click without drag
    }

    const dim: Dimension = {
      id: newId(),
      kind: 'arrow',
      anchor1: this.anchor1,
      anchor2: anchor2,
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
    if (!this.p1 || !this.snapPoint) return {};
    return {
      dimDraft: {
        p1: this.p1,
        p2: this.snapPoint,
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
