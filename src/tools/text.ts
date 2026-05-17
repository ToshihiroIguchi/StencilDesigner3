import type { AppState, Point, Polygon } from '../types';
import type { Font } from 'opentype.js';
import { BaseTool, type ToolContext } from './base';
import { AddShapesCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { loadFont, getCachedFont } from '../core/font-loader';
import { textToPolygons, isAsciiPrintable, computeTextAdvance } from '../core/text-to-polygon';
import { union } from '../core/boolean';

export class TextTool extends BaseTool {
  private mode: 'idle' | 'editing' = 'idle';
  private text = '';
  private capHeightUm = 5000;
  private letterSpacingUm = 0;

  private previewPolys: Polygon[] | null = null;
  private cursorOrigin: Point | null = null;
  private editOrigin: Point | null = null;
  private editPolys: Polygon[] | null = null;

  // Textarea overlay
  private textarea: HTMLTextAreaElement | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private boundOnInput: () => void;
  private boundOnKeyDown: (e: KeyboardEvent) => void;

  constructor(ctx: ToolContext) {
    super(ctx);
    void loadFont();
    this.textarea = document.getElementById('text-input') as HTMLTextAreaElement | null;
    this.boundOnInput = () => this.onTextareaInput();
    this.boundOnKeyDown = (e) => this.onTextareaKeyDown(e);
  }

  setParams(capHeightUm: number, letterSpacingUm: number): void {
    this.capHeightUm = capHeightUm;
    this.letterSpacingUm = letterSpacingUm;
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  isEditing(): boolean { return this.mode === 'editing'; }

  getTextPreviewPolys(): Polygon[] | null {
    return this.mode === 'editing' ? this.editPolys : this.previewPolys;
  }

  getTextCursor(): { x: number; topY: number; bottomY: number } | null {
    if (this.mode !== 'editing' || !this.editOrigin) return null;
    const font = getCachedFont();
    if (!font) return null;
    const advance = computeTextAdvance(this.text, font, this.capHeightUm, this.letterSpacingUm);
    return {
      x: this.editOrigin.x + advance,
      topY: this.editOrigin.y,
      bottomY: this.editOrigin.y + this.capHeightUm,
    };
  }

  // ── Textarea lifecycle ───────────────────────────────────────────────────────

  private openTextarea(canvasPt: Point, worldPt: Point): void {
    if (!this.textarea) return;
    this.editOrigin = worldPt;
    this.text = '';
    this.editPolys = null;

    this.textarea.value = '';
    this.syncTextareaStyle();
    this.textarea.style.left = `${canvasPt.x}px`;
    this.textarea.style.top = `${canvasPt.y}px`;
    this.textarea.style.display = '';
    this.mode = 'editing';

    this.autoResizeWidth();
    this.textarea.addEventListener('input', this.boundOnInput);
    this.textarea.addEventListener('keydown', this.boundOnKeyDown);

    // Blur auto-commits with a small delay so canvas mousedown can cancel it first
    const onBlur = () => {
      this.blurTimer = setTimeout(() => {
        this.blurTimer = null;
        this.commitEdit();
      }, 80);
    };
    this.textarea.addEventListener('blur', onBlur, { once: true });

    setTimeout(() => { this.textarea?.focus(); }, 0);

    const hint = document.getElementById('text-hint');
    if (hint) hint.textContent = 'Editing… (Enter: confirm, Esc: cancel)';
    this.ctx.requestRender();
  }

  private syncTextareaStyle(): void {
    if (!this.textarea) return;
    const state = this.ctx.history.state;
    // Cap at 80px so the input box stays usable regardless of zoom/size
    const sizePx = Math.min(80, Math.max(12, this.capHeightUm * state.zoom));
    const layerColor = state.layers.find((l) => l.name === state.activeLayerName)?.color ?? '#ffffff';
    this.textarea.style.fontSize = `${sizePx}px`;
    this.textarea.style.lineHeight = '1.0';
    this.textarea.style.color = layerColor;
    this.textarea.style.height = `${sizePx + 4}px`;
  }

  private autoResizeWidth(): void {
    if (!this.textarea) return;
    const sizePx = parseFloat(this.textarea.style.fontSize) || 16;
    // Monospace: char width ≈ 0.6× font size
    const minWidth = sizePx * 2;
    this.textarea.style.width = `${Math.max(minWidth, this.text.length * sizePx * 0.6 + sizePx)}px`;
  }

  private hideTextarea(): void {
    if (!this.textarea) return;
    this.textarea.removeEventListener('input', this.boundOnInput);
    this.textarea.removeEventListener('keydown', this.boundOnKeyDown);
    this.textarea.style.display = 'none';
    this.textarea.value = '';
    this.mode = 'idle';
    this.editOrigin = null;
    this.editPolys = null;
    this.text = '';
    const hint = document.getElementById('text-hint');
    if (hint) hint.textContent = 'Click canvas to type';
  }

  // ── Input handlers ───────────────────────────────────────────────────────────

  private onTextareaInput(): void {
    if (!this.textarea) return;
    const raw = this.textarea.value;
    // Strip non-ASCII and prevent newlines
    const ascii = raw.replace(/[^\x20-\x7E]/g, '');
    if (ascii !== raw) this.textarea.value = ascii;
    this.text = ascii;
    this.autoResizeWidth();
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  private onTextareaKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      this.commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      this.cancelEdit();
    }
  }

  private commitEdit(): void {
    if (this.mode !== 'editing') return;
    // Save before hideTextarea() clears them
    const text = this.textarea?.value.replace(/[^\x20-\x7E]/g, '') ?? '';
    const placePt = this.editOrigin;
    this.hideTextarea();
    if (!text.trim() || !placePt || !isAsciiPrintable(text)) return;
    const font = getCachedFont();
    if (font) {
      this.placeSync(placePt, text, font);
    } else {
      void this.placeAsync(placePt, text);
    }
  }

  private cancelEdit(): void {
    this.hideTextarea();
    this.ctx.requestRender();
  }

  // ── Canvas events ────────────────────────────────────────────────────────────

  onMouseMove(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    if (this.mode === 'editing') return;
    const s = this.ctx.getSnap(worldPt);
    this.cursorOrigin = s.point;
    this.snap = s;
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  onMouseDown(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    const origin = this.ctx.getSnap(worldPt).point;
    if (this.mode === 'editing') {
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      this.commitEdit();
    }
    this.openTextarea(canvasPt, origin);
  }

  onMouseUp(): void {}

  // ── Polygon building ─────────────────────────────────────────────────────────

  private rebuildPolys(): void {
    if (this.mode === 'editing') {
      this.editPolys = this.buildPolys(this.editOrigin, this.text);
    } else {
      this.previewPolys = this.buildPolys(this.cursorOrigin, this.text);
    }
  }

  private buildPolys(topLeft: Point | null, text: string): Polygon[] | null {
    if (!topLeft || !isAsciiPrintable(text)) return null;
    const font = getCachedFont();
    if (!font) return null;
    const layer = this.ctx.history.state.activeLayerName;
    const baselineY = topLeft.y + this.capHeightUm;
    const raw = textToPolygons(text, font, this.capHeightUm, topLeft.x, baselineY, this.letterSpacingUm, layer);
    return union(raw);
  }

  private placeSync(topLeft: Point, text: string, font: Font): void {
    const layer = this.ctx.history.state.activeLayerName;
    const baselineY = topLeft.y + this.capHeightUm;
    const raw = textToPolygons(text, font, this.capHeightUm, topLeft.x, baselineY, this.letterSpacingUm, layer);
    const polys = union(raw);
    if (polys.length === 0) return;
    this.ctx.history.execute(new AddShapesCommand(polys));
    markDirty();
    this.ctx.requestRender();
  }

  private async placeAsync(topLeft: Point, text: string): Promise<void> {
    const font = await loadFont();
    this.placeSync(topLeft, text, font);
  }

  override cancel(): void {
    if (this.mode === 'editing') {
      if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
      const hasText = this.text.trim().length > 0;
      if (hasText) this.commitEdit(); else this.cancelEdit();
    }
    this.previewPolys = null;
    this.cursorOrigin = null;
    super.cancel();
  }
}
