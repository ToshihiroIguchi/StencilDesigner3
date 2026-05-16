import type { AppState, Dimension, DimensionAnchor, Point } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { DimDraft } from '../canvas/renderer';
import { AddDimensionCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { findEdgeAnchor } from '../core/anchor-pick';
import { centerlineEndpoints } from '../core/centerline-geometry';
import { resolveEdge } from '../core/dimension-resolve';

type Step = 'edge1' | 'edge2';

export class CenterlineTool extends BaseTool {
  private step: Step = 'edge1';
  private edge1: DimensionAnchor | null = null;
  // Hovered edge anchor (used for preview and snap indicator)
  private hoverEdge: DimensionAnchor | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const worldRadius = state.snapRadius / state.zoom;
    const ea = findEdgeAnchor(worldPt, state.shapes, worldRadius);
    if (!ea) return;

    if (this.step === 'edge1') {
      this.edge1 = ea;
      this.step = 'edge2';
    } else if (this.step === 'edge2' && this.edge1) {
      // Reject same edge
      if (
        ea.kind === 'edge' && this.edge1.kind === 'edge' &&
        ea.shapeId === this.edge1.shapeId &&
        ea.edgeStartId === this.edge1.edgeStartId &&
        ea.edgeEndId === this.edge1.edgeEndId
      ) return;

      const e1 = resolveEdge(this.edge1, state.shapes);
      const e2 = resolveEdge(ea, state.shapes);
      let a1 = this.edge1;
      let a2 = ea;
      if (e1 && e2) {
        const cl = centerlineEndpoints(e1, e2);
        if (cl) {
          if (a1.kind === 'edge') a1 = { ...a1, cachedPoint: cl.p1 };
          if (a2.kind === 'edge') a2 = { ...a2, cachedPoint: cl.p2 };
        }
      }
      const dim: Dimension = {
        id: newId(),
        kind: 'centerline',
        anchor1: a1,
        anchor2: a2,
        offset: 0,
        layer: 'DIMENSIONS',
        frozen: false,
      };
      this.ctx.history.execute(new AddDimensionCommand(dim));
      markDirty();
      this.edge1 = null;
      this.hoverEdge = null;
      this.step = 'edge1';
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const worldRadius = state.snapRadius / state.zoom;
    this.hoverEdge = findEdgeAnchor(worldPt, state.shapes, worldRadius);
    this.snapPoint = this.hoverEdge?.kind === 'edge' ? this.hoverEdge.cachedPoint : null;
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  getDimDraft(state: AppState): DimDraft | null {
    if (this.step === 'edge1') {
      if (!this.hoverEdge || this.hoverEdge.kind !== 'edge') return null;
      return { p1: this.hoverEdge.cachedPoint };
    }
    // edge2: show preview centerline
    if (!this.edge1 || this.edge1.kind !== 'edge') return null;
    if (!this.hoverEdge || this.hoverEdge.kind !== 'edge') {
      return { p1: this.edge1.cachedPoint };
    }
    const e1 = resolveEdge(this.edge1, state.shapes);
    const e2 = resolveEdge(this.hoverEdge, state.shapes);
    if (e1 && e2) {
      const cl = centerlineEndpoints(e1, e2);
      if (cl) return { p1: cl.p1, p2: cl.p2, kind: 'centerline' };
    }
    return { p1: this.edge1.cachedPoint, p2: this.hoverEdge.cachedPoint, kind: 'centerline' };
  }

  getStep(): Step { return this.step; }

  override cancel(): void {
    this.edge1 = null;
    this.hoverEdge = null;
    this.step = 'edge1';
    super.cancel();
  }
}
