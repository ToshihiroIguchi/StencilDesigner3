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

  onKeyDown(_key: string, _state: AppState): void {}

  cancel(): void {
    this.draft = null;
    this.snap = null;
    this.ctx.requestRender();
  }
}
