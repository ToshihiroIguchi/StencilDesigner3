import type { AppState, Point, Dimension, DimensionAnchor } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { DimDraft } from '../canvas/renderer';
import { AddDimensionCommand } from '../state/commands';
import { markDirty } from '../state/autosave';
import { findVertexAnchor } from '../core/anchor-pick';

type DimStep = 'v1' | 'v2' | 'offset';

export class DimensionTool extends BaseTool {
  private step: DimStep = 'v1';
  private anchor1: DimensionAnchor | null = null;
  private anchor2: DimensionAnchor | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    const worldRadius = state.snapRadius / state.zoom;

    if (this.step === 'v1') {
      const va = findVertexAnchor(snapped, state.shapes, worldRadius);
      this.anchor1 = va ?? { kind: 'free', point: snapped };
      this.step = 'v2';
    } else if (this.step === 'v2') {
      if (!this.anchor1) return;
      const a1pt = this.anchorPoint(this.anchor1);
      if (snapped.x === a1pt.x && snapped.y === a1pt.y) return;
      const va = findVertexAnchor(snapped, state.shapes, worldRadius);
      this.anchor2 = va ?? { kind: 'free', point: snapped };
      this.step = 'offset';
    } else if (this.step === 'offset' && this.anchor1 && this.anchor2) {
      const p1 = this.anchorPoint(this.anchor1);
      const p2 = this.anchorPoint(this.anchor2);
      const kind = this.pickKind(p1, p2, snapped);
      const offset = kind === 'linear-h' ? snapped.y : snapped.x;
      const dim: Dimension = {
        id: newId(),
        kind,
        anchor1: this.anchor1,
        anchor2: this.anchor2,
        offset,
        layer: 'DIMENSIONS',
        frozen: false,
      };
      this.ctx.history.execute(new AddDimensionCommand(dim));
      markDirty();
      // Chain: next dimension starts from anchor2
      this.anchor1 = this.anchor2;
      this.anchor2 = null;
      this.step = 'v2';
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  private anchorPoint(a: DimensionAnchor): Point {
    if (a.kind === 'free') return a.point;
    return a.cachedPoint;
  }

  private pickKind(p1: Point, p2: Point, mouse: Point): 'linear-h' | 'linear-v' {
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    return Math.abs(mouse.y - midY) >= Math.abs(mouse.x - midX) ? 'linear-h' : 'linear-v';
  }

  getDimDraft(): DimDraft | null {
    if (!this.anchor1) return null;
    const p1 = this.anchorPoint(this.anchor1);
    const p2 = this.anchor2 ? this.anchorPoint(this.anchor2) : (this.snapPoint ?? undefined);
    if (!p2) return { p1 };
    if (this.step !== 'offset') return { p1, p2 };
    const mouse = this.snapPoint ?? p2;
    const kind = this.pickKind(p1, p2, mouse);
    const offset = kind === 'linear-h' ? mouse.y : mouse.x;
    return { p1, p2, kind, offset };
  }

  getStep(): DimStep { return this.step; }

  override cancel(): void {
    this.anchor1 = null;
    this.anchor2 = null;
    this.step = 'v1';
    super.cancel();
  }
}
