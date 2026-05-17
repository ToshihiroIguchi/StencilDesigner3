import type { AppState, Point } from '../types';
import { BaseTool, type ToolContext } from './base';
import { AddShapesCommand } from '../state/commands';
import { markDirty } from '../state/docStore';
import { loadFont } from '../core/font-loader';
import { textToPolygons } from '../core/text-to-polygon';

export interface TextDialogParams {
  text: string;
  capHeightUm: number;
  letterSpacingUm: number;
}

export class TextTool extends BaseTool {
  constructor(
    ctx: ToolContext,
    private readonly onRequestDialog: (
      worldPt: Point,
      cb: (params: TextDialogParams | null) => void,
    ) => void,
  ) {
    super(ctx);
    void loadFont(); // prefetch on tool activation
  }

  onMouseDown(worldPt: Point, _cp: Point, _shift: boolean, _state: AppState): void {
    const origin = this.ctx.getSnapPoint(worldPt);
    this.onRequestDialog(origin, (params) => {
      if (params) void this.place(params, origin);
    });
  }

  private async place(p: TextDialogParams, origin: Point): Promise<void> {
    const font = await loadFont();
    const layer = this.ctx.history.state.activeLayerName;
    const polys = textToPolygons(
      p.text, font, p.capHeightUm,
      origin.x, origin.y, p.letterSpacingUm, layer,
    );
    if (polys.length === 0) return;
    this.ctx.history.execute(new AddShapesCommand(polys));
    markDirty();
    this.ctx.requestRender();
  }

  onMouseMove(): void {}
  onMouseUp(): void {}
}
