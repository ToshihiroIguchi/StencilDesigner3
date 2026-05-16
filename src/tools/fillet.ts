import type { AppState, Point, Polygon, Ring } from '../types';
import { BaseTool, type ToolContext } from './base';
import { hitTest } from '../core/selection';
import { applyFillet, roundAllCorners, filletSkipMessage } from '../core/fillet';
import { FilletCommand, FilletAllCommand } from '../state/commands';
import { hasSelfIntersection, normalize } from '../normalize';
import { markDirty } from '../state/docStore';
import { savePrefs } from '../state/autosave';
import type { DraftShape, FilletVertexStatus } from '../canvas/renderer';

type VtxKey = string; // `${shapeId}_${holeIndex}_${index}`

export class FilletTool extends BaseTool {
  private R: number;
  private hoveredVtx: { shapeId: string; holeIndex: number; index: number } | null = null;
  private previewDraft: DraftShape | null = null;
  private vtxStatuses: Map<VtxKey, FilletVertexStatus> = new Map();
  private statusMessage = '';

  constructor(ctx: ToolContext, initialR = 500) {
    super(ctx);
    this.R = initialR;
    this.recomputeStatuses(ctx.history.state);
  }

  showsAllVertices(): boolean { return true; }

  override getDraft(): DraftShape | null { return this.previewDraft; }

  getRadius(): number { return this.R; }

  setRadius(r: number, state: AppState): void {
    this.R = r;
    savePrefs({ filletRadius: r }).catch(() => {});
    this.recomputeStatuses(state);
    this.updatePreview(state);
    this.ctx.requestRender();
  }

  getVertexStatuses(): Map<VtxKey, FilletVertexStatus> { return this.vtxStatuses; }

  getStatusMessage(): string { return this.statusMessage; }

  onMouseDown(_worldPt: Point, canvasPt: Point, _shift: boolean, state: AppState): void {
    if (!this.hoveredVtx) return;

    const { shapeId, holeIndex, index } = this.hoveredVtx;
    const status = this.vtxStatuses.get(`${shapeId}_${holeIndex}_${index}`);
    if (status === 'skip' || status === 'bad') return;

    const shape = state.shapes.find((s) => s.id === shapeId);
    if (!shape) return;

    const ring: Ring = holeIndex < 0 ? shape.outer : shape.holes[holeIndex];
    const result = applyFillet(ring, index, this.R);
    if (result.skipped) {
      this.statusMessage = filletSkipMessage(result.reason);
      this.ctx.requestRender();
      return;
    }
    if (hasSelfIntersection(result.ring)) {
      this.statusMessage = 'Self-intersection detected. Reduce R.';
      this.ctx.requestRender();
      return;
    }

    this.ctx.history.execute(new FilletCommand(shape, holeIndex, result.ring));
    markDirty();
    this.statusMessage = `Applied R=${this.R}µm`;

    this.hoveredVtx = null;
    this.previewDraft = null;
    this.recomputeStatuses(this.ctx.history.state);

    // Re-detect hover at same canvas position after shape change
    const newState = this.ctx.history.state;
    const hit = hitTest(canvasPt.x, canvasPt.y, newState.shapes, newState, newState.snapRadius);
    if (hit?.type === 'vertex') {
      this.hoveredVtx = { shapeId: hit.shapeId, holeIndex: hit.holeIndex, index: hit.index };
      this.vtxStatuses.set(`${hit.shapeId}_${hit.holeIndex}_${hit.index}`, 'hover');
      this.updatePreview(newState);
    }

    this.ctx.requestRender();
  }

  onMouseMove(worldPt: Point, canvasPt: Point, _shift: boolean, state: AppState): void {
    this.snapPoint = this.ctx.getSnapPoint(worldPt);

    const hit = hitTest(canvasPt.x, canvasPt.y, state.shapes, state, state.snapRadius);

    if (hit?.type === 'vertex') {
      const same = this.hoveredVtx &&
        this.hoveredVtx.shapeId === hit.shapeId &&
        this.hoveredVtx.holeIndex === hit.holeIndex &&
        this.hoveredVtx.index === hit.index;

      if (!same) {
        if (this.hoveredVtx) this.restoreVtxStatus(this.hoveredVtx, state);
        this.hoveredVtx = { shapeId: hit.shapeId, holeIndex: hit.holeIndex, index: hit.index };
        this.vtxStatuses.set(`${hit.shapeId}_${hit.holeIndex}_${hit.index}`, 'hover');
        this.updatePreview(state);
      }
    } else {
      if (this.hoveredVtx) {
        this.restoreVtxStatus(this.hoveredVtx, state);
        this.hoveredVtx = null;
        this.previewDraft = null;
        this.statusMessage = '';
      }
    }

    this.ctx.requestRender();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {}

  override onKeyDown(key: string, state: AppState): void {
    if (document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement) return;

    if (key === 'ArrowUp') {
      this.setRadius(this.R + state.gridSize, state);
    } else if (key === 'ArrowDown') {
      this.setRadius(Math.max(1, this.R - state.gridSize), state);
    } else if (key === 'Enter') {
      if (this.hoveredVtx && this.previewDraft) {
        const dummy: Point = { x: 0, y: 0 };
        this.onMouseDown(dummy, dummy, false, state);
      }
    }
  }

  /** Apply fillet R to all corners of selected shapes (single undoable command). */
  applyToAllCorners(state: AppState): void {
    const ids = state.selection.length > 0
      ? new Set(state.selection.map((s) => s.shapeId))
      : null;

    const before: Polygon[] = [];
    const after: Polygon[] = [];
    let totalApplied = 0, totalSkipped = 0;

    for (const shape of state.shapes) {
      if (ids && !ids.has(shape.id)) continue;

      const { ring: newOuter, applied: oa, skipped: os } = roundAllCorners(shape.outer, this.R);
      const outerOk = oa > 0 && !hasSelfIntersection(newOuter);

      const holeResults = shape.holes.map((h) => {
        const { ring, applied, skipped } = roundAllCorners(h, this.R);
        return { ring, applied, skipped, ok: applied > 0 && !hasSelfIntersection(ring) };
      });

      const anyChange = outerOk || holeResults.some((r) => r.ok);
      if (!anyChange) {
        totalSkipped += oa + os + holeResults.reduce((s, r) => s + r.applied + r.skipped, 0);
        continue;
      }

      totalApplied += (outerOk ? oa : 0) + holeResults.reduce((s, r) => s + (r.ok ? r.applied : 0), 0);
      totalSkipped += (outerOk ? os : oa + os) +
        holeResults.reduce((s, r) => s + (r.ok ? r.skipped : r.applied + r.skipped), 0);

      before.push(shape);
      after.push(normalize({
        ...shape,
        outer: outerOk ? newOuter : shape.outer,
        holes: shape.holes.map((h, i) => holeResults[i].ok ? holeResults[i].ring : h),
      }));
    }

    if (before.length === 0) {
      this.statusMessage = totalSkipped > 0
        ? `0 applied (${totalSkipped} skipped)`
        : ids ? 'No applicable vertices' : 'Select a shape first';
      this.ctx.requestRender();
      return;
    }

    this.ctx.history.execute(new FilletAllCommand(before, after));
    markDirty();
    this.statusMessage = `${totalApplied} vertices applied, ${totalSkipped} skipped`;

    this.hoveredVtx = null;
    this.previewDraft = null;
    this.recomputeStatuses(this.ctx.history.state);
    this.ctx.requestRender();
  }

  recomputeStatuses(state: AppState): void {
    this.vtxStatuses.clear();
    for (const shape of state.shapes) {
      const rings = [
        { ring: shape.outer, hi: -1 },
        ...shape.holes.map((h, i) => ({ ring: h, hi: i })),
      ];
      for (const { ring, hi } of rings) {
        for (let vi = 0; vi < ring.length; vi++) {
          const result = applyFillet(ring, vi, this.R);
          const status: FilletVertexStatus = result.skipped
            ? 'skip'
            : hasSelfIntersection(result.ring) ? 'bad' : 'ok';
          this.vtxStatuses.set(`${shape.id}_${hi}_${vi}`, status);
        }
      }
    }
    if (this.hoveredVtx) {
      const { shapeId, holeIndex, index } = this.hoveredVtx;
      this.vtxStatuses.set(`${shapeId}_${holeIndex}_${index}`, 'hover');
    }
  }

  private updatePreview(state: AppState): void {
    if (!this.hoveredVtx) { this.previewDraft = null; return; }

    const { shapeId, holeIndex, index } = this.hoveredVtx;
    const shape = state.shapes.find((s) => s.id === shapeId);
    if (!shape) { this.previewDraft = null; return; }

    const ring: Ring = holeIndex < 0 ? shape.outer : shape.holes[holeIndex];
    const result = applyFillet(ring, index, this.R);

    if (result.skipped) {
      this.previewDraft = null;
      this.statusMessage = filletSkipMessage(result.reason);
      this.vtxStatuses.set(`${shapeId}_${holeIndex}_${index}`, 'skip');
      return;
    }
    if (hasSelfIntersection(result.ring)) {
      this.previewDraft = null;
      this.statusMessage = 'Self-intersection detected. Reduce R.';
      this.vtxStatuses.set(`${shapeId}_${holeIndex}_${index}`, 'bad');
      return;
    }

    this.previewDraft = { type: 'fillet-preview', points: result.ring };
    this.statusMessage = `R = ${this.R}µm — click to apply`;
    this.vtxStatuses.set(`${shapeId}_${holeIndex}_${index}`, 'hover');
  }

  private restoreVtxStatus(
    vtx: { shapeId: string; holeIndex: number; index: number },
    state: AppState,
  ): void {
    const { shapeId, holeIndex, index } = vtx;
    const shape = state.shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const ring: Ring = holeIndex < 0 ? shape.outer : shape.holes[holeIndex];
    const result = applyFillet(ring, index, this.R);
    const status: FilletVertexStatus = result.skipped
      ? 'skip'
      : hasSelfIntersection(result.ring) ? 'bad' : 'ok';
    this.vtxStatuses.set(`${shapeId}_${holeIndex}_${index}`, status);
  }
}
