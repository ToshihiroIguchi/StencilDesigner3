import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { hitTest } from '../core/selection';
import { applyFillet, filletSkipMessage } from '../core/fillet';
import { FilletCommand } from '../state/commands';
import { hasSelfIntersection } from '../normalize';
import { markDirty } from '../state/autosave';

export class FilletTool extends BaseTool {
  private lastR = 500; // µm, persists across clicks

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  showsAllVertices(): boolean { return true; }

  onMouseDown(_worldPt: Point, canvasPt: Point, _shift: boolean, state: AppState): void {
    const hit = hitTest(canvasPt.x, canvasPt.y, state.shapes, state, state.snapRadius);
    if (!hit || hit.type !== 'vertex') return;

    const rStr = prompt('フィレット半径 (µm):', String(this.lastR));
    if (!rStr) return;
    const R = parseInt(rStr, 10);
    if (isNaN(R) || R <= 0) { alert('無効な値です'); return; }
    this.lastR = R;

    const shape = state.shapes.find((s) => s.id === hit.shapeId);
    if (!shape) return;

    const ring = hit.holeIndex < 0 ? shape.outer : shape.holes[hit.holeIndex];
    const result = applyFillet(ring, hit.index, R);

    if (result.skipped) {
      alert(`フィレット適用不可: ${filletSkipMessage(result.reason)}`);
      return;
    }

    if (hasSelfIntersection(result.ring)) {
      alert('フィレット後に自己交差が発生します。Rを小さくしてください。');
      return;
    }

    try {
      this.ctx.history.execute(new FilletCommand(shape, hit.holeIndex, result.ring));
      markDirty();
    } catch (e) {
      alert(`フィレット適用エラー: ${e}`);
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);
    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}
}
