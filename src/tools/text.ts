import type { AppState, Point, Polygon } from '../types';
import type { Font } from 'opentype.js';
import { BaseTool, type ToolContext } from './base';
import { AddShapesCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { loadFont, getCachedFont } from '../core/font-loader';
import { textToPolygons, isAsciiPrintable } from '../core/text-to-polygon';
import { union } from '../core/boolean';

export class TextTool extends BaseTool {
  private text = '';
  private capHeightUm = 5000;
  private letterSpacingUm = 0;
  private previewPolys: Polygon[] | null = null;
  private cursorOrigin: Point | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    void loadFont();
  }

  setParams(text: string, capHeightUm: number, letterSpacingUm: number): void {
    this.text = text;
    this.capHeightUm = capHeightUm;
    this.letterSpacingUm = letterSpacingUm;
    this.previewPolys = null;
    if (this.cursorOrigin) this.updatePreview();
    this.ctx.requestRender();
  }

  getTextPreviewPolys(): Polygon[] | null {
    return this.previewPolys;
  }

  private updatePreview(): void {
    if (!this.cursorOrigin || !isAsciiPrintable(this.text)) {
      this.previewPolys = null;
      return;
    }
    const font = getCachedFont();
    if (!font) { this.previewPolys = null; return; }
    const layer = this.ctx.history.state.activeLayerName;
    const raw = textToPolygons(
      this.text, font, this.capHeightUm,
      this.cursorOrigin.x, this.cursorOrigin.y, this.letterSpacingUm, layer,
    );
    this.previewPolys = union(raw);
  }

  onMouseMove(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    this.cursorOrigin = this.ctx.getSnapPoint(worldPt);
    this.snapPoint = this.cursorOrigin;
    this.updatePreview();
    this.ctx.requestRender();
  }

  onMouseDown(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    if (!isAsciiPrintable(this.text)) return;
    const origin = this.ctx.getSnapPoint(worldPt);
    const font = getCachedFont();
    if (font) {
      this.placeSync(origin, font);
    } else {
      void this.placeAsync(origin);
    }
  }

  private placeSync(origin: Point, font: Font): void {
    const layer = this.ctx.history.state.activeLayerName;
    const raw = textToPolygons(
      this.text, font, this.capHeightUm,
      origin.x, origin.y, this.letterSpacingUm, layer,
    );
    const polys = union(raw);
    if (polys.length === 0) return;
    this.ctx.history.execute(new AddShapesCommand(polys));
    markDirty();
    this.ctx.requestRender();
  }

  private async placeAsync(origin: Point): Promise<void> {
    const font = await loadFont();
    this.placeSync(origin, font);
  }

  onMouseUp(): void {}

  cancel(): void {
    this.previewPolys = null;
    this.cursorOrigin = null;
    super.cancel();
  }
}
