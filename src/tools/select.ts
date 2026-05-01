import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { hitTest, rubberBandSelect } from '../core/selection';
import { MoveCommand, SetSelectionCommand } from '../state/commands';
import { markDirty } from '../state/autosave';

export class SelectTool extends BaseTool {
  private isDragging = false;
  private dragStart: Point | null = null;
  private moveOrigin: Point | null = null;
  private isRubberBand = false;
  private rubberBandEnd: Point | null = null;
  private movedDx = 0;
  private movedDy = 0;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void {
    this.dragStart = { ...worldPt };
    this.moveOrigin = { ...worldPt };
    this.isDragging = false;
    this.isRubberBand = false;
    this.movedDx = 0;
    this.movedDy = 0;

    const hit = hitTest(canvasPt.x, canvasPt.y, state.shapes, state, state.snapRadius);
    if (hit) {
      const alreadySelected = state.selection.some((s) => s.shapeId === hit.shapeId);
      if (!alreadySelected) {
        const newSel = shift
          ? [...state.selection, hit]
          : [hit];
        this.ctx.history.execute(new SetSelectionCommand(newSel, state.selection));
      } else if (shift) {
        const newSel = state.selection.filter((s) => s.shapeId !== hit.shapeId);
        this.ctx.history.execute(new SetSelectionCommand(newSel, state.selection));
      }
      this.isDragging = true;
    } else {
      if (!shift) {
        this.ctx.history.execute(new SetSelectionCommand([], state.selection));
      }
      this.isRubberBand = true;
      this.rubberBandEnd = { ...canvasPt };
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, canvasPt: Point, _shift: boolean, state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);

    if (this.isDragging && this.moveOrigin && state.selection.length > 0) {
      const dx = worldPt.x - this.moveOrigin.x;
      const dy = worldPt.y - this.moveOrigin.y;
      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        // Live preview move
        this.movedDx += dx;
        this.movedDy += dy;
        this.ctx.history.execute(new MoveCommand(state.selection, dx, dy));
        markDirty();
        this.moveOrigin = { ...worldPt };
      }
    }

    if (this.isRubberBand) {
      this.rubberBandEnd = { ...canvasPt };
    }

    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void {
    if (this.isRubberBand && this.dragStart && this.rubberBandEnd) {
      const vt = { zoom: state.zoom, panX: state.panX, panY: state.panY };
      const startCanvas = { x: this.dragStart.x * state.zoom + state.panX, y: this.dragStart.y * state.zoom + state.panY };
      const sel = rubberBandSelect(startCanvas.x, startCanvas.y, canvasPt.x, canvasPt.y, state.shapes, vt);
      if (sel.length > 0) {
        const newSel = shift ? [...state.selection, ...sel] : sel;
        this.ctx.history.execute(new SetSelectionCommand(newSel, state.selection));
        markDirty();
      }
    }
    this.isDragging = false;
    this.isRubberBand = false;
    this.dragStart = null;
    this.moveOrigin = null;
    this.rubberBandEnd = null;
    this.ctx.requestRender();
  }

  getRubberBand(): { start: Point; end: Point } | null {
    if (!this.isRubberBand || !this.dragStart || !this.rubberBandEnd) return null;
    const vt = this.ctx.history.state;
    const startCanvas = {
      x: this.dragStart.x * vt.zoom + vt.panX,
      y: this.dragStart.y * vt.zoom + vt.panY,
    };
    return { start: startCanvas, end: this.rubberBandEnd };
  }
}
