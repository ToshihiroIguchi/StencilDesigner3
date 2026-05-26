import type { History } from '../state/history';
import { UnitConverter } from '../core/format';
import { savePrefs } from '../state/autosave';
import { markDirty } from '../state/docStore';
import { polygonBbox } from '../core/geometry';
import { resizePolygon } from '../core/transform';
import { MoveCommand, ResizeCommand } from '../state/commands';
import { TextTool } from '../tools/text';
import { AnnotationTool } from '../tools/annotation';
import { RectTool } from '../tools/rect';
import { CircleTool } from '../tools/circle';
import { FilletTool } from '../tools/fillet';
import type { DrcConfig } from '../core/drc';

export interface PanelBindingsDeps {
  history: History;
  getActiveTool(): unknown;
  requestRender(): void;
  setTextCapHeight(um: number): void;
  setTextLetterSpacing(um: number): void;
  setAnnotationHeight(um: number): void;
  setFilletRadius(um: number): void;
  getDrcConfig(): DrcConfig;
  setDrcConfig(cfg: DrcConfig): void;
}

export function bindPanelInputs(deps: PanelBindingsDeps): void {
  // Text panel
  const textSizeInput = document.getElementById('text-size') as HTMLInputElement | null;
  const textSpacingInput = document.getElementById('text-spacing') as HTMLInputElement | null;
  const syncTextParams = () => {
    const unit = deps.history.state.displayUnit;
    const cap = UnitConverter.parseInput(textSizeInput?.value ?? '5', unit);
    const spacing = UnitConverter.parseInput(textSpacingInput?.value ?? '0', unit);
    deps.setTextCapHeight(cap);
    deps.setTextLetterSpacing(spacing);
    const tool = deps.getActiveTool();
    if (tool instanceof TextTool) tool.setParams(cap, spacing);
  };
  textSizeInput?.addEventListener('input', syncTextParams);
  textSpacingInput?.addEventListener('input', syncTextParams);

  // Annotation panel
  const annSizeInput = document.getElementById('ann-size') as HTMLInputElement | null;
  const syncAnnParams = () => {
    const unit = deps.history.state.displayUnit;
    const h = UnitConverter.parseInput(annSizeInput?.value ?? '5', unit);
    deps.setAnnotationHeight(h);
    const tool = deps.getActiveTool();
    if (tool instanceof AnnotationTool) tool.setHeightUm(h);
  };
  annSizeInput?.addEventListener('input', syncAnnParams);

  // Rect draw panel
  const rectXInput = document.getElementById('rect-x') as HTMLInputElement | null;
  const rectYInput = document.getElementById('rect-y') as HTMLInputElement | null;
  const rectWInput = document.getElementById('rect-w') as HTMLInputElement | null;
  const rectHInput = document.getElementById('rect-h') as HTMLInputElement | null;
  const syncRectParams = () => {
    const tool = deps.getActiveTool();
    if (!(tool instanceof RectTool)) return;
    const unit = deps.history.state.displayUnit;
    tool.setPlaceX(UnitConverter.parseInput(rectXInput?.value ?? '0', unit));
    tool.setPlaceY(UnitConverter.parseInput(rectYInput?.value ?? '0', unit));
    tool.setWidth(UnitConverter.parseInput(rectWInput?.value ?? '10', unit));
    tool.setHeight(UnitConverter.parseInput(rectHInput?.value ?? '10', unit));
  };
  const placeRect = () => {
    const tool = deps.getActiveTool();
    if (!(tool instanceof RectTool)) return;
    syncRectParams();
    tool.placeFromPanel(deps.history.state);
  };
  rectXInput?.addEventListener('input', syncRectParams);
  rectYInput?.addEventListener('input', syncRectParams);
  rectWInput?.addEventListener('input', syncRectParams);
  rectHInput?.addEventListener('input', syncRectParams);
  for (const el of [rectXInput, rectYInput, rectWInput, rectHInput]) {
    el?.addEventListener('keydown', (e) => { if (e.key === 'Enter') placeRect(); });
  }
  document.getElementById('btn-place-rect')?.addEventListener('click', placeRect);

  // Circle draw panel
  const circleXInput = document.getElementById('circle-x') as HTMLInputElement | null;
  const circleYInput = document.getElementById('circle-y') as HTMLInputElement | null;
  const circleDInput = document.getElementById('circle-d') as HTMLInputElement | null;
  const syncCircleParams = () => {
    const tool = deps.getActiveTool();
    if (!(tool instanceof CircleTool)) return;
    const unit = deps.history.state.displayUnit;
    tool.setPlaceX(UnitConverter.parseInput(circleXInput?.value ?? '0', unit));
    tool.setPlaceY(UnitConverter.parseInput(circleYInput?.value ?? '0', unit));
    tool.setDiameter(UnitConverter.parseInput(circleDInput?.value ?? '5', unit));
  };
  const placeCircle = () => {
    const tool = deps.getActiveTool();
    if (!(tool instanceof CircleTool)) return;
    syncCircleParams();
    tool.placeFromPanel(deps.history.state);
  };
  circleXInput?.addEventListener('input', syncCircleParams);
  circleYInput?.addEventListener('input', syncCircleParams);
  circleDInput?.addEventListener('input', syncCircleParams);
  for (const el of [circleXInput, circleYInput, circleDInput]) {
    el?.addEventListener('keydown', (e) => { if (e.key === 'Enter') placeCircle(); });
  }
  document.getElementById('btn-place-circle')?.addEventListener('click', placeCircle);

  // Fillet panel
  const filletRInput = document.getElementById('fillet-r') as HTMLInputElement | null;
  filletRInput?.addEventListener('input', () => {
    const r = UnitConverter.parseInput(filletRInput.value, deps.history.state.displayUnit);
    if (r <= 0) return;
    deps.setFilletRadius(r);
    savePrefs({ filletRadius: r }).catch(() => {});
    const tool = deps.getActiveTool();
    if (tool instanceof FilletTool) tool.setRadius(r, deps.history.state);
  });
  document.getElementById('btn-fillet-all')?.addEventListener('click', () => {
    const tool = deps.getActiveTool();
    if (tool instanceof FilletTool) tool.applyToAllCorners(deps.history.state);
  });

  // Numeric properties panel
  const propX = document.getElementById('prop-x') as HTMLInputElement | null;
  const propY = document.getElementById('prop-y') as HTMLInputElement | null;
  const propW = document.getElementById('prop-w') as HTMLInputElement | null;
  const propH = document.getElementById('prop-h') as HTMLInputElement | null;

  const applyPropXY = () => {
    const state = deps.history.state;
    if (!propX || !propY) return;
    const ids = new Set(state.selection.map((s) => s.shapeId));
    const shapes = state.shapes.filter((s) => ids.has(s.id));
    if (shapes.length !== 1) return;
    const bb = polygonBbox(shapes[0]);
    const newX = UnitConverter.parseInput(propX.value, state.displayUnit);
    const newY = UnitConverter.parseInput(propY.value, state.displayUnit);
    const dx = newX - bb.minX;
    const dy = newY - bb.minY;
    if (dx === 0 && dy === 0) return;
    deps.history.execute(new MoveCommand(state.selection, dx, dy));
    markDirty();
    deps.requestRender();
  };

  const applyPropWH = () => {
    const state = deps.history.state;
    if (!propW || !propH) return;
    const ids = new Set(state.selection.map((s) => s.shapeId));
    const shapes = state.shapes.filter((s) => ids.has(s.id));
    if (shapes.length !== 1) return;
    const bb = polygonBbox(shapes[0]);
    const newW = UnitConverter.parseInput(propW.value, state.displayUnit);
    const newH = UnitConverter.parseInput(propH.value, state.displayUnit);
    if (newW < 1 || newH < 1) return;
    if (newW === bb.maxX - bb.minX && newH === bb.maxY - bb.minY) return;
    const resized = resizePolygon(shapes[0], bb.minX, bb.minY, newW, newH);
    deps.history.execute(new ResizeCommand(shapes[0], resized));
    markDirty();
    deps.requestRender();
  };

  propX?.addEventListener('change', applyPropXY);
  propY?.addEventListener('change', applyPropXY);
  propW?.addEventListener('change', applyPropWH);
  propH?.addEventListener('change', applyPropWH);

  // DRC config
  const drcApertureInput = document.getElementById('drc-min-aperture') as HTMLInputElement | null;
  const drcSpacingInput = document.getElementById('drc-min-spacing') as HTMLInputElement | null;
  drcApertureInput?.addEventListener('change', () => {
    const v = UnitConverter.parseInput(drcApertureInput.value, deps.history.state.displayUnit);
    if (v > 0) {
      deps.setDrcConfig({ ...deps.getDrcConfig(), minApertureUm: v });
      savePrefs({ drcMinApertureUm: v }).catch(() => {});
      deps.requestRender();
    }
  });
  drcSpacingInput?.addEventListener('change', () => {
    const v = UnitConverter.parseInput(drcSpacingInput.value, deps.history.state.displayUnit);
    if (v >= 0) {
      deps.setDrcConfig({ ...deps.getDrcConfig(), minSpacingUm: v });
      savePrefs({ drcMinSpacingUm: v }).catch(() => {});
      deps.requestRender();
    }
  });
}
