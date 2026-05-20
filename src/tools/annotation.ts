import type { AppState, Annotation, Point } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import { AddAnnotationCommand, EditAnnotationCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { TextareaOverlay } from './textarea-overlay';

export class AnnotationTool extends BaseTool {
  private previewPt: Point | null = null;
  private heightUm: number;

  private readonly textarea: HTMLTextAreaElement | null;
  private readonly overlay: TextareaOverlay;

  constructor(ctx: ToolContext, heightUm = 1000) {
    super(ctx);
    this.heightUm = heightUm;
    this.textarea = document.getElementById('annotation-input') as HTMLTextAreaElement | null;
    this.overlay = new TextareaOverlay({
      elementId: 'annotation-input',
      hintElementId: 'ann-hint',
      hintEditing: 'Shift+Enter: newline',
      hintIdle: 'Click to place',
      allowNewlines: true,
    });
  }

  setHeightUm(h: number): void {
    this.heightUm = h;
    if (this.overlay.isOpen) this.syncStyle();
  }

  isEditing(): boolean { return this.overlay.isOpen; }
  getPreviewPt(): Point | null { return this.previewPt; }

  // ── Public: open in edit mode for an existing annotation (dbl-click) ────────

  startEdit(ann: Annotation, canvasPt: Point): void {
    this.openOverlay(canvasPt, ann.origin, ann.id, ann.text);
  }

  // ── Mouse handlers ───────────────────────────────────────────────────────────

  onMouseDown(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snapped = this.ctx.getSnap(worldPt).point;
    if (this.overlay.isOpen) {
      this.overlay.cancelBlurTimer();
      this.overlay.commit();
    }
    this.openOverlay(canvasPt, snapped, null, '');
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    this.previewPt = s.point;
    this.snap = s;
    this.ctx.requestRender();
  }

  onMouseUp(): void {}

  // ── Overlay lifecycle ────────────────────────────────────────────────────────

  private openOverlay(
    canvasPt: Point,
    worldPt: Point,
    editId: string | null,
    initialText: string,
  ): void {
    const placePt = worldPt;
    this.overlay.open(canvasPt, initialText, {
      syncStyle: () => this.syncStyle(),
      onInput: (_, el) => {
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      },
      onCommit: (text) => {
        if (!text.trim()) return;
        if (editId) {
          this.ctx.history.execute(new EditAnnotationCommand(editId, { text }));
        } else {
          const ann: Annotation = {
            id: newId(),
            text,
            origin: placePt,
            heightUm: this.heightUm,
            layer: 'DIMENSIONS',
          };
          this.ctx.history.execute(new AddAnnotationCommand(ann));
        }
        markDirty();
        this.ctx.requestRender();
      },
      onDiscard: () => {
        this.ctx.requestRender();
      },
    });
  }

  private syncStyle(): void {
    if (!this.textarea) return;
    const state = this.ctx.history.state;
    const sizePx = Math.max(8, this.heightUm * state.zoom);
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const color = layerMap.get('DIMENSIONS')?.color ?? '#aabbdd';
    this.textarea.style.fontSize = `${sizePx}px`;
    this.textarea.style.lineHeight = '1.2';
    this.textarea.style.color = color;
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
  }

  override cancel(): void {
    if (this.overlay.isOpen) {
      this.overlay.cancelBlurTimer();
      const hasText = this.overlay.value.trim().length > 0;
      if (hasText) this.overlay.commit(); else this.overlay.discard();
    }
    this.previewPt = null;
    super.cancel();
  }
}
