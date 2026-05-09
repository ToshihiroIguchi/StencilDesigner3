import type { AppState, Point, Annotation } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import type { AnnDraft } from '../canvas/renderer';
import { AddAnnotationCommand } from '../state/commands';
import { markDirty } from '../state/autosave';

export class TextTool extends BaseTool {
  private anchor: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    if (!this.anchor) {
      this.anchor = snapped;
      this.ctx.requestRender();
      return;
    }
    const textPos = snapped;
    const text = prompt('Annotation text:');
    if (!text || !text.trim()) return;
    const layer = state.layers.some((l) => l.name === 'DIMENSIONS') ? 'DIMENSIONS' : state.activeLayerName;
    const ann: Annotation = {
      id: newId(), kind: 'leader',
      anchor: this.anchor, textPos,
      text: text.trim(), layer,
    };
    this.ctx.history.execute(new AddAnnotationCommand(ann));
    markDirty();
    // Keep anchor at textPos for chaining
    this.anchor = textPos;
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  getAnnDraft(): AnnDraft | null {
    if (!this.anchor) return null;
    return { anchor: this.anchor, textPos: this.snapPoint ?? undefined };
  }

  override cancel(): void {
    this.anchor = null;
    super.cancel();
  }
}
