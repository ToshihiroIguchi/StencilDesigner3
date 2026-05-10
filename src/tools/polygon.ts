import type { AppState, Point, Vertex } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import { normalize, hasSelfIntersection } from '../normalize';
import { AddShapeCommand } from '../state/commands';
import { markDirty } from '../state/autosave';
import { segmentsIntersect } from '../core/geometry';
import { vertex } from '../core/vertex';

export class PolygonTool extends BaseTool {
  private vertices: Vertex[] = [];
  private hoverPt: Point | null = null;
  private willClose = false;
  private hasSelfIntersect = false;

  private static readonly ANGLE_SNAP_DEG = 15;

  constructor(ctx: ToolContext) {
    super(ctx);
  }

  showsAllVertices(): boolean { return false; }

  isDrawing(): boolean { return this.vertices.length > 0; }
  vertexCount(): number { return this.vertices.length; }

  onMouseDown(worldPt: Point, canvasPt: Point, shift: boolean, state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    const pt = shift && this.vertices.length > 0
      ? this.constrainAngle(this.vertices[this.vertices.length - 1], snapped)
      : snapped;

    // Close polygon when clicking near the first vertex
    if (this.willClose && this.vertices.length >= 3) {
      this.commit(state);
      return;
    }

    // Ignore duplicate consecutive point
    if (this.vertices.length > 0) {
      const last = this.vertices[this.vertices.length - 1];
      if (last.x === pt.x && last.y === pt.y) return;
    }

    this.vertices.push(vertex(pt.x, pt.y));
    this.updateDraft();
    void canvasPt; // unused but kept for interface consistency
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, shift: boolean, state: AppState): void {
    const snapped = this.ctx.getSnapPoint(worldPt);
    this.hoverPt = shift && this.vertices.length > 0
      ? this.constrainAngle(this.vertices[this.vertices.length - 1], snapped)
      : snapped;

    // willClose: world-space distance to first vertex ≤ snap threshold
    this.willClose = false;
    if (this.vertices.length >= 3) {
      const first = this.vertices[0];
      const dx = this.hoverPt.x - first.x;
      const dy = this.hoverPt.y - first.y;
      const worldDist = Math.sqrt(dx * dx + dy * dy);
      const thresholdWorld = state.snapRadius / state.zoom;
      this.willClose = worldDist <= thresholdWorld;
    }

    this.hasSelfIntersect = this.detectSelfIntersect();
    this.updateDraft();
  }

  onMouseUp(_worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    // No-op: polygon is click-based
  }

  onKeyDown(key: string, state: AppState): void {
    if (key === 'Enter') {
      this.commit(state);
    } else if (key === 'Backspace') {
      this.popVertex();
    }
  }

  /** Called on dblclick: remove the extra vertex from the second mousedown, then commit. */
  commitFromDblClick(state: AppState): void {
    if (this.vertices.length > 1) {
      const last = this.vertices[this.vertices.length - 1];
      const prev = this.vertices[this.vertices.length - 2];
      if (last.x === prev.x && last.y === prev.y) {
        this.vertices.pop();
      }
    }
    this.commit(state);
  }

  cancel(): void {
    this.vertices = [];
    this.hoverPt = null;
    this.willClose = false;
    this.hasSelfIntersect = false;
    super.cancel();
  }

  private commit(state: AppState): void {
    if (this.vertices.length < 3) return;
    // Final validation uses committed vertices only — independent of hover state
    if (hasSelfIntersection(this.vertices)) return;
    try {
      const poly = normalize({
        id: newId(),
        outer: this.vertices,
        holes: [],
        layer: state.activeLayerName,
      });
      this.ctx.history.execute(new AddShapeCommand(poly));
      markDirty();
    } catch {
      // Degenerate polygon — ignore
    }
    this.cancel();
  }

  private popVertex(): void {
    if (this.vertices.length > 0) {
      this.vertices.pop();
      this.hasSelfIntersect = this.detectSelfIntersect();
      this.updateDraft();
    }
  }

  private updateDraft(): void {
    if (this.vertices.length === 0) {
      this.draft = null;
      this.snapPoint = this.hoverPt;
      this.ctx.requestRender();
      return;
    }

    const pts: { x: number; y: number }[] = [...this.vertices];
    if (this.hoverPt) pts.push(this.hoverPt);

    this.draft = {
      type: 'polygon',
      points: pts,
      selfIntersects: this.hasSelfIntersect,
      willClose: this.willClose,
    };
    this.snapPoint = this.hoverPt;
    this.ctx.requestRender();
  }

  private constrainAngle(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return to;

    const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
    const step = PolygonTool.ANGLE_SNAP_DEG;
    const snappedDeg = Math.round(angleDeg / step) * step;
    const rad = snappedDeg * (Math.PI / 180);

    return {
      x: Math.round(from.x + dist * Math.cos(rad)),
      y: Math.round(from.y + dist * Math.sin(rad)),
    };
  }

  private detectSelfIntersect(): boolean {
    const verts = this.vertices;
    const hover = this.hoverPt;
    if (verts.length < 2 || !hover) return false;

    // Skip if hover equals last vertex (no pending edge to check)
    const last = verts[verts.length - 1];
    if (hover.x === last.x && hover.y === last.y) return false;

    // Pending edge: last committed vertex → hover
    const p1 = last;
    const p2 = hover;

    // Check pending edge against all non-adjacent committed edges
    for (let i = 0; i < verts.length - 2; i++) {
      if (segmentsIntersect(p1, p2, verts[i], verts[i + 1])) return true;
    }

    // Check closing edge (hover → vertex[0]) against interior edges
    if (verts.length >= 3) {
      const q1 = hover;
      const q2 = verts[0];
      // Skip edges adjacent to q2 (vertex[0]) and q1 (hover-side, last edge)
      for (let i = 1; i < verts.length - 1; i++) {
        if (segmentsIntersect(q1, q2, verts[i], verts[i + 1])) return true;
      }
    }

    return false;
  }
}
