import type { AppState, Point, Polygon } from '../types';
import { BaseTool, type ToolContext } from './base';
import { CutCommand } from '../state/commands';
import { cutPolygon } from '../core/cut';
import { constrainAngle } from '../core/geometry';
import { markDirty } from '../state/docStore';

export class CutTool extends BaseTool {
  private p1: Point | null = null;

  private static readonly ANGLE_SNAP_DEG = 15;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  onMouseDown(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snap = this.ctx.getSnap(worldPt);
    this.p1 = snap.point;
    this.snap = snap;
    this.draft = null;
    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, _state: AppState): void {
    const snap = this.ctx.getSnap(worldPt);
    const pt = (shift && this.p1)
      ? constrainAngle(this.p1, snap.point, CutTool.ANGLE_SNAP_DEG)
      : snap.point;
    this.snap = { ...snap, point: pt };

    if (this.p1) {
      this.draft = { type: 'line', points: [this.p1, pt] };
    }
    this.ctx.requestRender();
  }

  onMouseUp(worldPt: Point, _canvasPt: Point, shift: boolean, state: AppState): void {
    if (!this.p1) return;

    const snap = this.ctx.getSnap(worldPt);
    const p2 = (shift)
      ? constrainAngle(this.p1, snap.point, CutTool.ANGLE_SNAP_DEG)
      : snap.point;

    if (p2.x === this.p1.x && p2.y === this.p1.y) {
      this.reset();
      return;
    }

    this.executeCut(this.p1, p2, state);
    this.reset();
  }

  hasP1(): boolean { return this.p1 !== null; }

  override cancel(): void {
    this.reset();
    super.cancel();
  }

  private reset(): void {
    this.p1 = null;
    this.draft = null;
    this.snap = null;
  }

  private executeCut(p1: Point, p2: Point, state: AppState): void {
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const candidates = state.shapes.filter((s) => {
      const l = layerMap.get(s.layer);
      return l && l.visible && !l.locked;
    });

    const originals: Polygon[] = [];
    const pieces: Polygon[] = [];
    let degenerate = false;

    for (const poly of candidates) {
      const result = cutPolygon(poly, p1, p2);
      if (result.status === 'cut') {
        originals.push(poly);
        pieces.push(...result.pieces);
      } else if (result.status === 'degenerate') {
        degenerate = true;
      }
    }

    if (originals.length === 0) {
      if (degenerate) {
        this.ctx.notify("Couldn't cut a shape — the line runs along its edge.");
      } else {
        this.ctx.notify('Nothing was cut — draw the line across a shape.');
      }
      this.ctx.requestRender();
      return;
    }

    this.ctx.history.execute(new CutCommand(originals, pieces));
    markDirty();
    this.ctx.requestRender();
  }
}
