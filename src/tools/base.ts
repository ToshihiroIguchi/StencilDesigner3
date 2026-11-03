import type { AppState, Point } from '../types';
import type { DraftShape } from '../canvas/renderer';
import type { History } from '../state/history';
import type { SnapResult, SelectionSnapResult } from '../core/snap';

export interface ToolContext {
  history: History;
  getSnap: (worldPt: Point) => SnapResult;
  getSelectionSnap: (
    movingShapes: import('../types').Polygon[],
    dragStartWorld: Point,
    currentMouseWorld: Point
  ) => SelectionSnapResult;
  requestRender: () => void;
  notify: (msg: string) => void;
}

export abstract class BaseTool {
  protected ctx: ToolContext;
  protected draft: DraftShape | null = null;
  protected snap: SnapResult | null = null;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  getDraft(): DraftShape | null { return this.draft; }
  getSnap(): SnapResult | null { return this.snap; }
  showsAllVertices(): boolean { return false; }

  abstract onMouseDown(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void;
  abstract onMouseMove(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void;
  abstract onMouseUp(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void;

  /** Returns true (and notifies the user) when the active layer is locked and drawing must be refused. */
  protected isActiveLayerLocked(state: AppState): boolean {
    const layer = state.layers.find((l) => l.name === state.activeLayerName);
    if (layer?.locked) {
      this.ctx.notify('Active layer is locked');
      return true;
    }
    return false;
  }

  /**
   * Returns true (and notifies the user) when the DIMENSIONS layer exists but is locked or hidden,
   * so dimensions, arrows, centerlines and notes would be created invisibly or against a lock.
   */
  protected isDimensionsLayerBlocked(state: AppState): boolean {
    const layer = state.layers.find((l) => l.name === 'DIMENSIONS');
    if (layer?.locked) {
      this.ctx.notify('DIMENSIONS layer is locked');
      return true;
    }
    if (layer && !layer.visible) {
      this.ctx.notify('DIMENSIONS layer is hidden');
      return true;
    }
    return false;
  }

  onKeyDown(_key: string, _state: AppState): void {}

  cancel(): void {
    this.draft = null;
    this.snap = null;
    this.ctx.requestRender();
  }
}
