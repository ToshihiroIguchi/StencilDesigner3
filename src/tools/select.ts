import type { AppState, Annotation, Command, Point, Polygon, Selection } from '../types';
import { BaseTool, type ToolContext } from './base';
import { hitTest, hitTestAnnotation, hitTestDimension, rubberBandSelect } from '../core/selection';
import { CompoundCommand, MoveAnnotationCommand, MoveCommand, SetSelectionCommand } from '../state/commands';
import { translatePolygon } from '../core/geometry';
import { markDirty } from '../state/docStore';
import type { SelectionSnapResult } from '../core/snap';

const DRAG_THRESHOLD_PX = 5;

export class SelectTool extends BaseTool {
  private isDragging = false;
  private dragStartCanvas: Point | null = null;
  private dragStartWorld: Point | null = null;
  private moveOrigin: Point | null = null;
  private dragThresholdReached = false;
  private pendingDx = 0;
  private pendingDy = 0;
  private savedShapes: Polygon[] | null = null;
  private savedAnnotations: Annotation[] | null = null;
  private savedSelection: Selection[] | null = null;
  private selectionSnap: SelectionSnapResult | null = null;

  private isRubberBand = false;
  private rubberBandStart: Point | null = null;
  private rubberBandEnd: Point | null = null;

  getSelectionSnapResult(): SelectionSnapResult | null {
    return this.selectionSnap;
  }

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void {
    this.dragStartCanvas = { ...canvasPt };
    this.moveOrigin = { ...worldPt };
    this.dragThresholdReached = false;
    this.pendingDx = 0;
    this.pendingDy = 0;

    let hit: Selection | null = null;
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const interactiveDims = state.dimensions.filter((d) => {
      const l = layerMap.get(d.layer);
      return l && l.visible && !l.locked;
    });
    const interactiveAnns = state.annotations.filter((a) => {
      const l = layerMap.get(a.layer);
      return l && l.visible && !l.locked;
    });
    const dimHit = hitTestDimension(canvasPt.x, canvasPt.y, interactiveDims, state.shapes, state, state.snapRadius);
    if (dimHit) {
      hit = { type: 'dimension', shapeId: dimHit.id, index: -1, holeIndex: -1 };
    } else {
      const annHit = hitTestAnnotation(canvasPt.x, canvasPt.y, interactiveAnns, state);
      if (annHit) {
        hit = { type: 'annotation', shapeId: annHit.id, index: -1, holeIndex: -1 };
      } else {
        hit = hitTest(canvasPt.x, canvasPt.y, state.shapes, state, state.snapRadius);
      }
    }
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
      this.savedAnnotations = [...cur.annotations];
      this.savedSelection = [...cur.selection];

      // Snap the origin for movement reference
      this.moveOrigin = this.ctx.getSnap(worldPt).point;
      this.dragStartWorld = { ...this.moveOrigin };
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

  onMouseMove(worldPt: Point, canvasPt: Point, shift: boolean, _state: AppState): void {
    const state = this.ctx.history.state;

    if (this.isDragging && state.selection.length > 0 && this.dragStartCanvas && this.dragStartWorld) {
      if (!this.dragThresholdReached) {
        const dxPx = canvasPt.x - this.dragStartCanvas.x;
        const dyPx = canvasPt.y - this.dragStartCanvas.y;
        if (Math.sqrt(dxPx * dxPx + dyPx * dyPx) > DRAG_THRESHOLD_PX) {
          this.dragThresholdReached = true;
        }
      }

      if (this.dragThresholdReached) {
        // Collect moving shapes
        const ids = new Set(state.selection.filter((s) => s.type === 'polygon').map((s) => s.shapeId));
        const movingShapes = (this.savedShapes ?? state.shapes).filter((s) => ids.has(s.id));

        // Calculate advanced selection snap (excludes moving shapes internally)
        this.selectionSnap = this.ctx.getSelectionSnap(movingShapes, this.dragStartWorld, worldPt);

        // Keep this.snap in sync for generic renderer purposes, though selectionSnap is primary
        this.snap = {
          point: this.selectionSnap.targetPoint ?? {
            x: this.dragStartWorld.x + this.selectionSnap.delta.x,
            y: this.dragStartWorld.y + this.selectionSnap.delta.y,
          },
          kind: this.selectionSnap.kind,
        };

        let totalDx = this.selectionSnap.delta.x;
        let totalDy = this.selectionSnap.delta.y;

        if (shift) {
          // Ortho lock: constrain to dominant axis relative to drag start
          if (Math.abs(totalDx) >= Math.abs(totalDy)) totalDy = 0;
          else totalDx = 0;
        }

        const incDx = totalDx - this.pendingDx;
        const incDy = totalDy - this.pendingDy;

        if (incDx !== 0 || incDy !== 0) {
          this.pendingDx = totalDx;
          this.pendingDy = totalDy;

          const selIds = new Set(state.selection.map((s) => s.shapeId));
          state.shapes = state.shapes.map((shape) => {
            if (!selIds.has(shape.id)) return shape;
            return { ...translatePolygon(shape, incDx, incDy), id: shape.id };
          });
          // Move annotations live as well
          state.annotations = state.annotations.map((ann) => {
            if (!selIds.has(ann.id)) return ann;
            return { ...ann, origin: { x: ann.origin.x + incDx, y: ann.origin.y + incDy } };
          });
        }
      }
    } else {
      this.snap = this.ctx.getSnap(worldPt);
      this.selectionSnap = null;
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
        state.shapes, state.dimensions, vt, state.annotations
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
      state.annotations = this.savedAnnotations ?? state.annotations;
      if (this.pendingDx !== 0 || this.pendingDy !== 0) {
        const cmds: Command[] = [];
        const shapeSel = savedSel.filter((s) => s.type !== 'annotation');
        if (shapeSel.length > 0) {
          cmds.push(new MoveCommand(shapeSel, this.pendingDx, this.pendingDy));
        }
        const annIds = savedSel.filter((s) => s.type === 'annotation').map((s) => s.shapeId);
        for (const id of annIds) {
          const ann = state.annotations.find((a) => a.id === id);
          if (!ann) continue;
          const newOrigin = { x: ann.origin.x + this.pendingDx, y: ann.origin.y + this.pendingDy };
          cmds.push(new MoveAnnotationCommand(id, newOrigin));
        }
        if (cmds.length === 1) this.ctx.history.execute(cmds[0]);
        else if (cmds.length > 1) this.ctx.history.execute(new CompoundCommand(cmds));
        markDirty();
      }
    }

    this._reset();
    this.ctx.requestRender();
  }

  override cancel(): void {
    if (this.isDragging && this.dragThresholdReached && this.savedShapes) {
      this.ctx.history.state.shapes = this.savedShapes;
      if (this.savedAnnotations) this.ctx.history.state.annotations = this.savedAnnotations;
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
    this.dragStartWorld = null;
    this.moveOrigin = null;
    this.rubberBandStart = null;
    this.rubberBandEnd = null;
    this.savedShapes = null;
    this.savedAnnotations = null;
    this.savedSelection = null;
    this.dragThresholdReached = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.selectionSnap = null;
  }
}
