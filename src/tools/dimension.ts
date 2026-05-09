import type { AppState, Point, Dimension } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { DimDraft } from '../canvas/renderer';
import { AddDimensionCommand } from '../state/commands';
import { markDirty } from '../state/autosave';

type DimStep = 'p1' | 'p2' | 'offset';

export class DimensionTool extends BaseTool {
  private step: DimStep = 'p1';
  private p1: Point | null = null;
  private p2: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    if (this.step === 'p1') {
      this.p1 = snapped;
      this.step = 'p2';
    } else if (this.step === 'p2') {
      if (!this.p1) return;
      // Ignore same-point click
      if (snapped.x === this.p1.x && snapped.y === this.p1.y) return;
      this.p2 = snapped;
      this.step = 'offset';
    } else if (this.step === 'offset' && this.p1 && this.p2) {
      const kind = this.pickKind(this.p1, this.p2, snapped);
      const offset = kind === 'linear-h' ? snapped.y : snapped.x;
      const layer = state.layers.some((l) => l.name === 'DIMENSIONS') ? 'DIMENSIONS' : state.activeLayerName;
      const dim: Dimension = { id: newId(), kind, p1: this.p1, p2: this.p2, offset, layer };
      this.ctx.history.execute(new AddDimensionCommand(dim));
      markDirty();
      // Chain: next dimension starts from p2
      this.p1 = this.p2;
      this.p2 = null;
      this.step = 'p2';
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  /** Auto-detect kind: if the user drags perpendicular to p1→p2 in Y → linear-h (measures X span). */
  private pickKind(p1: Point, p2: Point, mouse: Point): 'linear-h' | 'linear-v' {
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    return Math.abs(mouse.y - midY) >= Math.abs(mouse.x - midX) ? 'linear-h' : 'linear-v';
  }

  getDimDraft(): DimDraft | null {
    if (!this.p1) return null;
    const p2 = this.p2 ?? this.snapPoint ?? undefined;
    if (!p2) return { p1: this.p1 };
    if (this.step !== 'offset') return { p1: this.p1, p2 };
    const mouse = this.snapPoint ?? p2;
    const kind = this.pickKind(this.p1, p2, mouse);
    const offset = kind === 'linear-h' ? mouse.y : mouse.x;
    return { p1: this.p1, p2, kind, offset };
  }

  getStep(): DimStep { return this.step; }

  override cancel(): void {
    this.p1 = null;
    this.p2 = null;
    this.step = 'p1';
    super.cancel();
  }
}
