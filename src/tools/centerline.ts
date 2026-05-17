import type { AppState, Dimension, DimensionAnchor, Point } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { DimDraft } from '../canvas/renderer';
import { AddDimensionCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { centerlineEndpoints } from '../core/centerline-geometry';
import { resolveEdge } from '../core/dimension-resolve';
import type { SnapResult } from '../core/snap';

type Step = 'edge1' | 'edge2';

export class CenterlineTool extends BaseTool {
  private step: Step = 'edge1';
  private edge1: DimensionAnchor | null = null;
  private hoverSnap: SnapResult | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    if (s.ref?.kind !== 'edge') return; // require edge snap

    const ea: DimensionAnchor = {
      kind: 'edge',
      shapeId: s.ref.shapeId,
      ringIndex: s.ref.ringIndex,
      edgeStartId: s.ref.edgeStartId,
      edgeEndId: s.ref.edgeEndId,
      t: s.ref.t,
      cachedPoint: s.point,
    };

    if (this.step === 'edge1') {
      this.edge1 = ea;
      this.step = 'edge2';
    } else if (this.step === 'edge2' && this.edge1) {
      // Reject same edge
      if (
        this.edge1.kind === 'edge' &&
        ea.shapeId === this.edge1.shapeId &&
        ea.edgeStartId === this.edge1.edgeStartId &&
        ea.edgeEndId === this.edge1.edgeEndId
      ) return;

      const e1 = resolveEdge(this.edge1, state.shapes);
      const e2 = resolveEdge(ea, state.shapes);
      let a1 = this.edge1;
      let a2: DimensionAnchor = ea;
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
      this.hoverSnap = null;
      this.step = 'edge1';
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    this.hoverSnap = s.ref?.kind === 'edge' ? s : null;
    this.snap = this.hoverSnap;
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  getDimDraft(state: AppState): DimDraft | null {
    if (this.step === 'edge1') {
      if (!this.hoverSnap || this.hoverSnap.ref?.kind !== 'edge') return null;
      return { p1: this.hoverSnap.point };
    }
    if (!this.edge1 || this.edge1.kind !== 'edge') return null;
    if (!this.hoverSnap || this.hoverSnap.ref?.kind !== 'edge') {
      return { p1: this.edge1.cachedPoint };
    }
    const e1 = resolveEdge(this.edge1, state.shapes);
    const e2ref = this.hoverSnap.ref;
    const hoverAnchor: DimensionAnchor = {
      kind: 'edge',
      shapeId: e2ref.shapeId,
      ringIndex: e2ref.ringIndex,
      edgeStartId: e2ref.edgeStartId,
      edgeEndId: e2ref.edgeEndId,
      t: e2ref.t,
      cachedPoint: this.hoverSnap.point,
    };
    const e2 = resolveEdge(hoverAnchor, state.shapes);
    if (e1 && e2) {
      const cl = centerlineEndpoints(e1, e2);
      if (cl) return { p1: cl.p1, p2: cl.p2, kind: 'centerline' };
    }
    return { p1: this.edge1.cachedPoint, p2: this.hoverSnap.point, kind: 'centerline' };
  }

  getStep(): Step { return this.step; }

  override cancel(): void {
    this.edge1 = null;
    this.hoverSnap = null;
    this.step = 'edge1';
    super.cancel();
  }
}
