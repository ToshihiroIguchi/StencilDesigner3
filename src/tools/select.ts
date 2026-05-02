import type { AppState, Point, Polygon, Selection } from '../types';
import { BaseTool, type ToolContext } from './base';
import { hitTest, rubberBandSelect } from '../core/selection';
import { MoveCommand, SetSelectionCommand } from '../state/commands';
import { translatePolygon } from '../core/geometry';
import { markDirty } from '../state/autosave';

const DRAG_THRESHOLD_PX = 5;

export class SelectTool extends BaseTool {
  private isDragging = false;
  private dragStartCanvas: Point | null = null;
  private moveOrigin: Point | null = null;
  private dragThresholdReached = false;
  private pendingDx = 0;
  private pendingDy = 0;
  private savedShapes: Polygon[] | null = null;
  private savedSelection: Selection[] | null = null;

  private isRubberBand = false;
  private rubberBandStart: Point | null = null;
  private rubberBandEnd: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void {
    this.dragStartCanvas = { ...canvasPt };
    this.moveOrigin = { ...worldPt };
    this.dragThresholdReached = false;
    this.pendingDx = 0;
    this.pendingDy = 0;

    const hit = hitTest(canvasPt.x, canvasPt.y, state.shapes, state, state.snapRadius);
    if (hit) {
      const alreadySelected = state.selection.some((s) => s.shapeId === hit.shapeId);
      if (!alreadySelected) {
        const newSel = shift ? [...state.selection, hit] : [hit];
        this.ctx.history.execute(new SetSelectionCommand(newSel, state.selection));
        this.isDragging = true;
      } else if (shift) {
        const newSel = state.selection.filter((s) => s.shapeId !== hit.shapeId);
        this.ctx.history.execute(new SetSelectionCommand(newSel, state.selection));
        this.isDragging = false;
      } else {
        this.isDragging = true;
      }
      const cur = this.ctx.history.state;
      this.savedShapes = [...cur.shapes];
      this.savedSelection = [...cur.selection];
    } else {
      this.isDragging = false;
      if (!shift) {
        this.ctx.history.execute(new SetSelectionCommand([], state.selection));
      }
      this.isRubberBand = true;
      this.rubberBandStart = { ...canvasPt };
      this.rubberBandEnd = { ...canvasPt };
    }
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);
    const state = this.ctx.history.state;

    if (this.isDragging && state.selection.length > 0 && this.dragStartCanvas && this.moveOrigin) {
      if (!this.dragThresholdReached) {
        const dxPx = canvasPt.x - this.dragStartCanvas.x;
        const dyPx = canvasPt.y - this.dragStartCanvas.y;
        if (Math.sqrt(dxPx * dxPx + dyPx * dyPx) > DRAG_THRESHOLD_PX) {
          this.dragThresholdReached = true;
        }
      }

      if (this.dragThresholdReached) {
        const dx = worldPt.x - this.moveOrigin.x;
        const dy = worldPt.y - this.moveOrigin.y;
        if (dx !== 0 || dy !== 0) {
          this.pendingDx += dx;
          this.pendingDy += dy;
          const ids = new Set(state.selection.map((s) => s.shapeId));
          state.shapes = state.shapes.map((shape) => {
            if (!ids.has(shape.id)) return shape;
            return { ...translatePolygon(shape, dx, dy), id: shape.id };
          });
          this.moveOrigin = { ...worldPt };
        }
      }
    }

    if (this.isRubberBand) {
      this.rubberBandEnd = { ...canvasPt };
    }

    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, canvasPt: Point, shift: boolean, _state: AppState): void {
    const state = this.ctx.history.state;

    if (this.isRubberBand && this.rubberBandStart) {
      const vt = { zoom: state.zoom, panX: state.panX, panY: state.panY };
      const sel = rubberBandSelect(
        this.rubberBandStart.x, this.rubberBandStart.y,
        canvasPt.x, canvasPt.y,
        state.shapes, vt
      );
      if (sel.length > 0) {
        const newSel = shift ? [...state.selection, ...sel] : sel;
        this.ctx.history.execute(new SetSelectionCommand(newSel, state.selection));
        markDirty();
      }
    }

    if (this.isDragging && this.dragThresholdReached && this.savedShapes && this.savedSelection) {
      const savedSel = this.savedSelection;
      state.shapes = this.savedShapes;
      if (this.pendingDx !== 0 || this.pendingDy !== 0) {
        this.ctx.history.execute(new MoveCommand(savedSel, this.pendingDx, this.pendingDy));
        markDirty();
      }
    }

    this._reset();
    this.ctx.requestRender();
  }

  override cancel(): void {
    if (this.isDragging && this.dragThresholdReached && this.savedShapes) {
      this.ctx.history.state.shapes = this.savedShapes;
    }
    this._reset();
    super.cancel();
  }

  getRubberBand(): { start: Point; end: Point } | null {
    if (!this.isRubberBand || !this.rubberBandStart || !this.rubberBandEnd) return null;
    return { start: this.rubberBandStart, end: this.rubberBandEnd };
  }

  private _reset(): void {
    this.isDragging = false;
    this.isRubberBand = false;
    this.dragStartCanvas = null;
    this.moveOrigin = null;
    this.rubberBandStart = null;
    this.rubberBandEnd = null;
    this.savedShapes = null;
    this.savedSelection = null;
    this.dragThresholdReached = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
  }
}
