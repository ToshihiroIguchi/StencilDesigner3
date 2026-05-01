import type { AppState, Point } from '../types';
import type { DraftShape } from '../canvas/renderer';
import type { History } from '../state/history';

export interface ToolContext {
  history: History;
  getSnapPoint: (worldPt: Point) => Point;
  requestRender: () => void;
}

export abstract class BaseTool {
  protected ctx: ToolContext;
  protected draft: DraftShape | null = null;
  protected snapPoint: Point | null = null;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  getDraft(): DraftShape | null { return this.draft; }
  getSnapPoint(): Point | null { return this.snapPoint; }

  abstract onMouseDown(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void;
  abstract onMouseMove(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void;
  abstract onMouseUp(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void;

  onKeyDown(_key: string, _state: AppState): void {}

  cancel(): void {
    this.draft = null;
    this.snapPoint = null;
    this.ctx.requestRender();
  }
}
