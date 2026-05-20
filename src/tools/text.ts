import type { AppState, Point, Polygon } from '../types';
import type { Font } from 'opentype.js';
import { BaseTool, type ToolContext } from './base';
import { AddShapesCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { loadFont, getCachedFont } from '../core/font-loader';
import { textToPolygons, isAsciiPrintable } from '../core/text-to-polygon';
import { union } from '../core/boolean';
import { TextareaOverlay } from './textarea-overlay';

export class TextTool extends BaseTool {
  private capHeightUm = 5000;
  private letterSpacingUm = 0;

  private previewPolys: Polygon[] | null = null;
  private editOrigin: Point | null = null;
  private editPolys: Polygon[] | null = null;

  private readonly textarea: HTMLTextAreaElement | null;
  private readonly overlay: TextareaOverlay;

  constructor(ctx: ToolContext) {
    super(ctx);
    void loadFont();
    this.textarea = document.getElementById('text-input') as HTMLTextAreaElement | null;
    this.overlay = new TextareaOverlay({
      elementId: 'text-input',
      hintElementId: 'text-hint',
      hintEditing: 'Editing… (Enter: confirm, Esc: cancel)',
      hintIdle: 'Click canvas to type',
      filterInput: (raw) => raw.replace(/[^\x20-\x7E]/g, ''),
    });
  }

  setParams(capHeightUm: number, letterSpacingUm: number): void {
    this.capHeightUm = capHeightUm;
    this.letterSpacingUm = letterSpacingUm;
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  isEditing(): boolean { return this.overlay.isOpen; }

  getTextPreviewPolys(): Polygon[] | null {
    return this.overlay.isOpen ? this.editPolys : this.previewPolys;
  }

  // ── Canvas events ────────────────────────────────────────────────────────────

  onMouseMove(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    if (this.overlay.isOpen) return;
    const s = this.ctx.getSnap(worldPt);
    this.snap = s;
    this.ctx.requestRender();
  }

  onMouseDown(worldPt: Point, canvasPt: Point, _shift: boolean, _state: AppState): void {
    const origin = this.ctx.getSnap(worldPt).point;
    if (this.overlay.isOpen) {
      this.overlay.cancelBlurTimer();
      this.overlay.commit();
    }
    this.openEditor(canvasPt, origin);
  }

  onMouseUp(): void {}

  // ── Editor lifecycle ─────────────────────────────────────────────────────────

  private openEditor(canvasPt: Point, worldPt: Point): void {
    this.editOrigin = worldPt;
    this.editPolys = null;
    this.overlay.open(canvasPt, '', {
      syncStyle: () => this.syncStyle(),
      onInput: (text, el) => {
        this.autoResizeWidth(el, text);
        this.rebuildPolys();
        this.ctx.requestRender();
      },
      onCommit: (text) => {
        const placePt = this.editOrigin;
        this.editOrigin = null;
        this.editPolys = null;
        if (!text.trim() || !placePt || !isAsciiPrintable(text)) return;
        const font = getCachedFont();
        if (font) this.placeSync(placePt, text, font);
        else void this.placeAsync(placePt, text);
      },
      onDiscard: () => {
        this.editOrigin = null;
        this.editPolys = null;
        this.ctx.requestRender();
      },
    });
    this.rebuildPolys();
    this.ctx.requestRender();
  }

  private syncStyle(): void {
    if (!this.textarea) return;
    const state = this.ctx.history.state;
    const sizePx = Math.max(8, this.capHeightUm * state.zoom);
    const layerColor = state.layers.find((l) => l.name === state.activeLayerName)?.color ?? '#ffffff';
    this.textarea.style.fontSize = `${sizePx}px`;
    this.textarea.style.lineHeight = '1.0';
    this.textarea.style.color = layerColor;
    this.textarea.style.height = `${sizePx + 4}px`;
  }

  private autoResizeWidth(el: HTMLTextAreaElement, text: string): void {
    const sizePx = parseFloat(el.style.fontSize) || 16;
    const minWidth = sizePx * 2;
    el.style.width = `${Math.max(minWidth, text.length * sizePx * 0.6 + sizePx)}px`;
  }

  // ── Polygon building ─────────────────────────────────────────────────────────

  private rebuildPolys(): void {
    if (this.overlay.isOpen) {
      this.editPolys = this.buildPolys(this.editOrigin, this.overlay.value);
    } else {
      this.previewPolys = null;
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
    if (this.overlay.isOpen) {
      this.overlay.cancelBlurTimer();
      const hasText = this.overlay.value.trim().length > 0;
      if (hasText) this.overlay.commit(); else this.overlay.discard();
    }
    this.previewPolys = null;
    super.cancel();
  }
}
