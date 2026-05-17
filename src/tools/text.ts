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

  // idle: hover preview follows cursor (top-left of cap-height box)
  private previewPolys: Polygon[] | null = null;
  private cursorOrigin: Point | null = null;

  // editing: fixed anchor + live preview
  private editOrigin: Point | null = null;
  private editPolys: Polygon[] | null = null;

  // ghost input for keyboard capture
  private ghostInput: HTMLInputElement | null = null;
  private boundOnInput: () => void;
  private boundOnKeyDown: (e: KeyboardEvent) => void;

  constructor(ctx: ToolContext) {
    super(ctx);
    void loadFont();
    this.ghostInput = document.getElementById('text-ghost-input') as HTMLInputElement | null;
    this.boundOnInput = () => this.onGhostInput();
    this.boundOnKeyDown = (e) => this.onGhostKeyDown(e);
    if (this.ghostInput) {
      this.ghostInput.addEventListener('input', this.boundOnInput);
      this.ghostInput.addEventListener('keydown', this.boundOnKeyDown);
    }
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

  private onGhostInput(): void {
    if (!this.ghostInput) return;
    const raw = this.ghostInput.value;
    const ascii = raw.replace(/[^\x20-\x7E]/g, '');
    if (ascii !== raw) this.ghostInput.value = ascii;
    this.text = ascii;
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  private onGhostKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancelEdit();
    }
  }

  private enterEditMode(origin: Point): void {
    this.mode = 'editing';
    this.editOrigin = origin;
    this.text = '';
    this.editPolys = null;
    if (this.ghostInput) {
      this.ghostInput.value = '';
      // Defer focus so the canvas mousedown/mouseup cycle doesn't steal it back
      setTimeout(() => this.ghostInput?.focus(), 0);
    }
    const hint = document.getElementById('text-hint');
    if (hint) hint.textContent = 'Editing… (Enter: confirm, Esc: cancel)';
    this.ctx.requestRender();
  }

  private commitEdit(): void {
    if (this.mode !== 'editing') return;
    if (isAsciiPrintable(this.text) && this.editOrigin) {
      const origin = this.editOrigin;
      const font = getCachedFont();
      if (font) {
        this.placeSync(origin, font);
      } else {
        void this.placeAsync(origin);
      }
    }
    this.resetEditState();
  }

  private cancelEdit(): void {
    this.resetEditState();
    this.ctx.requestRender();
  }

  private resetEditState(): void {
    this.mode = 'idle';
    this.editOrigin = null;
    this.editPolys = null;
    this.text = '';
    if (this.ghostInput) {
      this.ghostInput.value = '';
      this.ghostInput.blur();
    }
    const hint = document.getElementById('text-hint');
    if (hint) hint.textContent = 'Click canvas to type';
  }

  private rebuildPolys(): void {
    if (this.mode === 'editing') {
      this.editPolys = this.buildPolys(this.editOrigin);
    } else {
      this.previewPolys = this.buildPolys(this.cursorOrigin);
    }
  }

  // topLeft: top-left of the cap-height bounding box (snap point)
  // baseline = topLeft.y + capHeightUm (Y+ down, so baseline is below top)
  private buildPolys(topLeft: Point | null): Polygon[] | null {
    if (!topLeft || !isAsciiPrintable(this.text)) return null;
    const font = getCachedFont();
    if (!font) return null;
    const layer = this.ctx.history.state.activeLayerName;
    const baselineY = topLeft.y + this.capHeightUm;
    const raw = textToPolygons(
      this.text, font, this.capHeightUm,
      topLeft.x, baselineY, this.letterSpacingUm, layer,
    );
    return union(raw);
  }

  onMouseMove(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    if (this.mode === 'editing') return;
    this.cursorOrigin = this.ctx.getSnapPoint(worldPt);
    this.snapPoint = this.cursorOrigin;
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  onMouseDown(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    const origin = this.ctx.getSnapPoint(worldPt);
    if (this.mode === 'editing') {
      this.commitEdit();
    }
    this.enterEditMode(origin);
  }

  onMouseUp(): void {}

  private placeSync(topLeft: Point, font: Font): void {
    if (!isAsciiPrintable(this.text)) return;
    const layer = this.ctx.history.state.activeLayerName;
    const baselineY = topLeft.y + this.capHeightUm;
    const raw = textToPolygons(
      this.text, font, this.capHeightUm,
      topLeft.x, baselineY, this.letterSpacingUm, layer,
    );
    const polys = union(raw);
    if (polys.length === 0) return;
    this.ctx.history.execute(new AddShapesCommand(polys));
    markDirty();
    this.ctx.requestRender();
  }

  private async placeAsync(topLeft: Point): Promise<void> {
    const font = await loadFont();
    this.placeSync(topLeft, font);
  }

  cancel(): void {
    if (this.ghostInput) {
      this.ghostInput.removeEventListener('input', this.boundOnInput);
      this.ghostInput.removeEventListener('keydown', this.boundOnKeyDown);
    }
    this.resetEditState();
    this.previewPolys = null;
    this.cursorOrigin = null;
    super.cancel();
  }
}
