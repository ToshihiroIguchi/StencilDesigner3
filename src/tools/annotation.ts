import type { AppState, Annotation, Point } from '../types';
import { newId } from '../types';
import { BaseTool, type ToolContext } from './base';
import { AddAnnotationCommand, EditAnnotationCommand } from '../state/commands';
import { markDirty } from '../state/docStore';

export class AnnotationTool extends BaseTool {
  private previewPt: Point | null = null;
  private heightUm: number;

  // Textarea overlay managed by this tool
  private textarea: HTMLTextAreaElement | null;
  private isOpen = false;
  private placePt: Point | null = null;
  private editingId: string | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundInput: () => void;

  constructor(ctx: ToolContext, heightUm = 1000) {
    super(ctx);
    this.heightUm = heightUm;
    this.textarea = document.getElementById('annotation-input') as HTMLTextAreaElement | null;
    this.boundKeyDown = (e) => this.onTextareaKeyDown(e);
    this.boundInput = () => this.autoResize();
  }

  setHeightUm(h: number): void {
    this.heightUm = h;
    if (this.isOpen) this.syncTextareaStyle();
  }

  isEditing(): boolean { return this.isOpen; }
  getPreviewPt(): Point | null { return this.previewPt; }

  // ── Public: open in edit mode for an existing annotation (dbl-click) ────────

  startEdit(ann: Annotation, canvasPt: Point): void {
    this.openTextarea(canvasPt, ann.origin, ann.id, ann.text);
  }

  // ── Mouse handlers ───────────────────────────────────────────────────────────

  onMouseDown(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    const snapped = this.ctx.getSnap(worldPt).point;
    if (this.isOpen) {
      // Cancel the blur-based commit (we handle it here)
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      this.commit();
    }
    this.openTextarea(canvasPt, snapped, null, '');
  }

  onMouseMove(worldPt: Point, _canvasPt: Point, _shift: boolean, _state: AppState): void {
    const s = this.ctx.getSnap(worldPt);
    this.previewPt = s.point;
    this.snap = s;
    this.ctx.requestRender();
  }

  onMouseUp(): void {}

  // ── Textarea lifecycle ───────────────────────────────────────────────────────

  private openTextarea(canvasPt: Point, worldPt: Point, editId: string | null, initialText: string): void {
    if (!this.textarea) return;
    this.placePt = worldPt;
    this.editingId = editId;

    this.textarea.value = initialText;
    this.syncTextareaStyle();
    this.textarea.style.left = `${canvasPt.x}px`;
    this.textarea.style.top = `${canvasPt.y}px`;
    this.textarea.style.display = '';
    this.isOpen = true;

    this.autoResize();
    this.textarea.addEventListener('keydown', this.boundKeyDown);
    this.textarea.addEventListener('input', this.boundInput);

    // Blur auto-commits with a small delay so canvas mousedown can cancel it first
    const onBlur = () => {
      this.blurTimer = setTimeout(() => {
        this.blurTimer = null;
        this.commit();
      }, 80);
    };
    this.textarea.addEventListener('blur', onBlur, { once: true });

    setTimeout(() => { this.textarea?.focus(); this.textarea?.select(); }, 0);

    const hint = document.getElementById('ann-hint');
    if (hint) hint.textContent = 'Shift+Enter: newline';
    this.ctx.requestRender();
  }

  private syncTextareaStyle(): void {
    if (!this.textarea) return;
    const state = this.ctx.history.state;
    const sizePx = Math.max(8, this.heightUm * state.zoom);
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const color = layerMap.get('DIMENSIONS')?.color ?? '#aabbdd';
    this.textarea.style.fontSize = `${sizePx}px`;
    this.textarea.style.lineHeight = '1.2';
    this.textarea.style.color = color;
  }

  private autoResize(): void {
    if (!this.textarea) return;
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
  }

  private onTextareaKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      this.commit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      this.discard();
    }
  }

  private commit(): void {
    const text = this.textarea?.value ?? '';
    const placePt = this.placePt;
    const editingId = this.editingId;
    this.hideTextarea();
    if (!text.trim() || !placePt) return;

    if (editingId) {
      this.ctx.history.execute(new EditAnnotationCommand(editingId, { text }));
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
  }

  private discard(): void {
    this.hideTextarea();
    this.ctx.requestRender();
  }

  private hideTextarea(): void {
    if (!this.textarea) return;
    this.textarea.removeEventListener('keydown', this.boundKeyDown);
    this.textarea.removeEventListener('input', this.boundInput);
    this.textarea.style.display = 'none';
    this.textarea.value = '';
    this.isOpen = false;
    this.placePt = null;
    this.editingId = null;
    const hint = document.getElementById('ann-hint');
    if (hint) hint.textContent = 'Click to place';
  }

  override cancel(): void {
    if (this.isOpen) {
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      // Commit if there's text, discard otherwise
      const hasText = (this.textarea?.value ?? '').trim().length > 0;
      if (hasText) this.commit(); else this.discard();
    }
    this.previewPt = null;
    super.cancel();
  }
}
