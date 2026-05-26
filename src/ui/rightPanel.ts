import type { AppState, DrcError } from '../types';
import { UnitConverter } from '../core/format';
import { polygonArea, polygonBbox } from '../core/geometry';
import { resolveDimension } from '../core/dimension-resolve';
import { RectTool } from '../tools/rect';
import { CircleTool } from '../tools/circle';
import { FilletTool } from '../tools/fillet';
import { MeasureTool } from '../tools/measure';
import { DimensionTool } from '../tools/dimension';
import { CenterlineTool } from '../tools/centerline';
import { CutTool } from '../tools/cut';
import { PolygonTool } from '../tools/polygon';
import { TextTool } from '../tools/text';
import { AnnotationTool } from '../tools/annotation';
import { escHtml } from './fileManager';

export interface PanelDeps {
  getActiveTool(): unknown;
  getDrcErrors(): DrcError[];
  getDiffStep(): 0 | 1 | 2;
  isNotifying(): boolean;
  panToWorld(x: number, y: number): void;
}

export function updateFooter(state: AppState, deps: PanelDeps): void {
  if (deps.isNotifying()) return;
  const el = (id: string) => document.getElementById(id);
  const unit = state.displayUnit;
  const f = (v: number) => UnitConverter.formatOutput(v, unit);
  const activeTool = deps.getActiveTool();

  if (deps.getDiffStep() > 0) {
    const hint = deps.getDiffStep() === 1 ? 'Click BASE (keeps)' : 'Click CUT (removes)';
    if (el('footer-w')) el('footer-w')!.textContent = 'Diff:';
    if (el('footer-h')) el('footer-h')!.textContent = hint;
    if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
  } else if (activeTool instanceof MeasureTool) {
    const ov = activeTool.getMeasureOverlay();
    if (ov) {
      const dx = Math.abs(ov.p2.x - ov.p1.x);
      const dy = Math.abs(ov.p2.y - ov.p1.y);
      const d = Math.round(Math.sqrt(dx * dx + dy * dy));
      if (el('footer-w')) el('footer-w')!.textContent = `dx:${f(dx)}`;
      if (el('footer-h')) el('footer-h')!.textContent = `dy:${f(dy)}`;
      if (el('footer-area')) el('footer-area')!.textContent = `d:${f(d)}`;
    } else {
      if (el('footer-w')) el('footer-w')!.textContent = 'Click p1';
      if (el('footer-h')) el('footer-h')!.textContent = '—';
      if (el('footer-area')) el('footer-area')!.textContent = 'Esc clear';
    }
  } else if (activeTool instanceof CutTool) {
    if (activeTool.hasP1()) {
      if (el('footer-w')) el('footer-w')!.textContent = 'Cut:';
      if (el('footer-h')) el('footer-h')!.textContent = 'Click p2';
      if (el('footer-area')) el('footer-area')!.textContent = 'Shift=angle  Esc cancel';
    } else {
      if (el('footer-w')) el('footer-w')!.textContent = 'Cut:';
      if (el('footer-h')) el('footer-h')!.textContent = 'Click p1';
      if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
    }
  } else if (activeTool instanceof DimensionTool) {
    const steps = ['Click v1', 'Click v2', 'Click offset'];
    const step = activeTool.getStep() === 'v1' ? 0 : activeTool.getStep() === 'v2' ? 1 : 2;
    if (el('footer-w')) el('footer-w')!.textContent = 'Dim:';
    if (el('footer-h')) el('footer-h')!.textContent = steps[step];
    if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
  } else if (activeTool instanceof CenterlineTool) {
    const step = activeTool.getStep();
    if (el('footer-w')) el('footer-w')!.textContent = 'CL:';
    if (el('footer-h')) el('footer-h')!.textContent = step === 'edge1' ? 'Click edge 1' : 'Click edge 2';
    if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
  } else if (activeTool instanceof PolygonTool && activeTool.isDrawing()) {
    const n = activeTool.vertexCount();
    if (el('footer-w')) el('footer-w')!.textContent = `${n} pts`;
    if (el('footer-h')) el('footer-h')!.textContent = 'Enter/click①';
    if (el('footer-area')) el('footer-area')!.textContent = '⌫ undo  Shift=angle  Esc cancel';
  } else {
    const sel = state.selection;
    let w = 0, h = 0, a = 0;
    if (sel.length > 0) {
      const ids = new Set(sel.map((s) => s.shapeId));
      for (const shape of state.shapes) {
        if (!ids.has(shape.id)) continue;
        const bb = polygonBbox(shape);
        w = Math.max(w, bb.maxX - bb.minX);
        h = Math.max(h, bb.maxY - bb.minY);
        a += polygonArea(shape);
      }
    }
    if (el('footer-w')) el('footer-w')!.textContent = f(w);
    if (el('footer-h')) el('footer-h')!.textContent = f(h);
    if (el('footer-area')) {
      const areaStr = unit === 'mm' ? (a / 1000000).toFixed(4) : Math.round(a).toLocaleString();
      el('footer-area')!.textContent = areaStr;
    }
  }

  if (el('footer-grid')) el('footer-grid')!.textContent = UnitConverter.formatOutput(state.gridSize, unit, true);
  if (el('footer-snap')) el('footer-snap')!.textContent = state.snapEnabled ? 'ON' : 'OFF';
  if (el('footer-zoom')) {
    const pxPerMm = state.zoom * 1000;
    const zoomLabel = pxPerMm >= 100
      ? `${pxPerMm.toFixed(0)} px/mm`
      : pxPerMm >= 10
        ? `${pxPerMm.toFixed(1)} px/mm`
        : `${pxPerMm.toFixed(2)} px/mm`;
    el('footer-zoom')!.textContent = zoomLabel;
  }
}

export interface RightPanelDeps extends PanelDeps {
  renderLayerPanel(state: AppState): void;
}

export function updateRightPanel(state: AppState, deps: RightPanelDeps): void {
  const unit = state.displayUnit;
  const activeTool = deps.getActiveTool();

  // Show/hide rect draw panel and sync values
  const rectPanel = document.getElementById('rect-panel');
  const isRectActive = activeTool instanceof RectTool;
  if (rectPanel) rectPanel.style.display = isRectActive ? '' : 'none';
  if (isRectActive) {
    const rt = activeTool;
    const xIn = document.getElementById('rect-x') as HTMLInputElement | null;
    const yIn = document.getElementById('rect-y') as HTMLInputElement | null;
    const wIn = document.getElementById('rect-w') as HTMLInputElement | null;
    const hIn = document.getElementById('rect-h') as HTMLInputElement | null;
    if (xIn && document.activeElement !== xIn) xIn.value = UnitConverter.formatOutput(rt.getPlaceX(), unit);
    if (yIn && document.activeElement !== yIn) yIn.value = UnitConverter.formatOutput(rt.getPlaceY(), unit);
    if (wIn && document.activeElement !== wIn) wIn.value = UnitConverter.formatOutput(rt.getWidth(), unit);
    if (hIn && document.activeElement !== hIn) hIn.value = UnitConverter.formatOutput(rt.getHeight(), unit);
  }

  // Show/hide circle draw panel and sync values
  const circlePanel = document.getElementById('circle-panel');
  const isCircleActive = activeTool instanceof CircleTool;
  if (circlePanel) circlePanel.style.display = isCircleActive ? '' : 'none';
  if (isCircleActive) {
    const ct = activeTool;
    const xIn = document.getElementById('circle-x') as HTMLInputElement | null;
    const yIn = document.getElementById('circle-y') as HTMLInputElement | null;
    const dIn = document.getElementById('circle-d') as HTMLInputElement | null;
    if (xIn && document.activeElement !== xIn) xIn.value = UnitConverter.formatOutput(ct.getPlaceX(), unit);
    if (yIn && document.activeElement !== yIn) yIn.value = UnitConverter.formatOutput(ct.getPlaceY(), unit);
    if (dIn && document.activeElement !== dIn) dIn.value = UnitConverter.formatOutput(ct.getDiameter(), unit);
  }

  // Show/hide text panel
  const textPanel = document.getElementById('text-panel');
  if (textPanel) textPanel.style.display = activeTool instanceof TextTool ? '' : 'none';

  // Show/hide annotation panel
  const annPanel = document.getElementById('annotation-panel');
  if (annPanel) annPanel.style.display = activeTool instanceof AnnotationTool ? '' : 'none';

  // Show/hide fillet panel and sync its state
  const filletPanel = document.getElementById('fillet-panel');
  const isFilletActive = activeTool instanceof FilletTool;
  if (filletPanel) filletPanel.style.display = isFilletActive ? '' : 'none';
  if (isFilletActive) {
    const ft = activeTool;
    const rInput = document.getElementById('fillet-r') as HTMLInputElement | null;
    if (rInput) {
      const cur = UnitConverter.parseInput(rInput.value, state.displayUnit);
      if (cur !== ft.getRadius()) rInput.value = UnitConverter.formatOutput(ft.getRadius(), state.displayUnit);
    }
    const statusEl = document.getElementById('fillet-status');
    if (statusEl) statusEl.textContent = ft.getStatusMessage();
  }

  // DRC results
  const drcListEl = document.getElementById('drc-list');
  if (drcListEl) {
    const errors = deps.getDrcErrors();
    if (errors.length === 0) {
      drcListEl.innerHTML = '<p class="muted">No errors</p>';
      drcListEl.onclick = null;
    } else {
      const lines = errors.map((e, i) => {
        const cls = e.severity === 'error' ? 'drc-error' : 'drc-warning';
        const locAttr = e.loc ? ` data-idx="${i}"` : '';
        const cursor = e.loc ? ' style="cursor:pointer"' : '';
        return `<p class="${cls}"${locAttr}${cursor}>${e.message}</p>`;
      });
      if (errors.length >= 20) lines.push('<p class="muted">… (truncated at 20)</p>');
      drcListEl.innerHTML = lines.join('');
      drcListEl.onclick = (ev) => {
        const target = (ev.target as HTMLElement).closest('[data-idx]') as HTMLElement | null;
        if (!target) return;
        const idx = parseInt(target.dataset.idx ?? '', 10);
        const loc = errors[idx]?.loc;
        if (loc) deps.panToWorld(loc.x, loc.y);
      };
    }
  }

  // Layer panel
  deps.renderLayerPanel(state);

  const sel = state.selection;
  const selEl = document.getElementById('footer-sel');
  if (selEl) selEl.textContent = sel.length.toString();

  const infoEl = document.getElementById('selection-info');
  const propsEl = document.getElementById('shape-props');
  if (!infoEl) return;

  const annSels = sel.filter((s) => s.type === 'annotation');
  if (annSels.length === 1 && sel.length === 1) {
    const ann = state.annotations.find((a) => a.id === annSels[0].shapeId);
    if (ann) {
      const lines = ann.text.split('\n');
      const preview = lines[0].length > 24 ? lines[0].slice(0, 24) + '…' : lines[0];
      const layerColor = state.layers.find((l) => l.name === ann.layer)?.color ?? '#aabbdd';
      infoEl.innerHTML = `<div class="shape-info">
        <span style="color:${layerColor}">Note</span>
        <span style="white-space:pre-wrap;word-break:break-all">${escHtml(preview)}</span>
        <span style="color:var(--fg2)">Layer: ${ann.layer}</span>
      </div>
      <p style="font-size:11px;color:var(--fg2);margin-top:4px">Del: delete · Dbl-click: edit</p>`;
      if (propsEl) propsEl.style.display = 'none';
      return;
    }
  }

  const dimSels = sel.filter((s) => s.type === 'dimension');
  if (dimSels.length === 1 && sel.length === 1) {
    const dim = state.dimensions.find((d) => d.id === dimSels[0].shapeId);
    if (dim) {
      const { p1, p2, frozen } = resolveDimension(dim, state.shapes);
      let label: string;
      if (dim.kind === 'centerline') {
        const dx = Math.abs(p2.x - p1.x);
        const dy = Math.abs(p2.y - p1.y);
        const len = Math.round(Math.sqrt(dx * dx + dy * dy));
        label = `CL: ${UnitConverter.formatOutput(len, state.displayUnit, true)}`;
      } else {
        const val = dim.kind === 'linear-h'
          ? UnitConverter.formatOutput(Math.abs(p2.x - p1.x), state.displayUnit, true)
          : UnitConverter.formatOutput(Math.abs(p2.y - p1.y), state.displayUnit, true);
        label = `${dim.kind === 'linear-h' ? 'H' : 'V'}: ${val}`;
      }
      const frozenTag = frozen ? ' <span style="color:#7a7a8a">[frozen]</span>' : '';
      const title = dim.kind === 'centerline' ? 'Centerline' : 'Dimension';
      infoEl.innerHTML = `<div class="shape-info"><span>${title}${frozenTag}</span><span>${label}</span><span style="color:var(--fg2)">Layer: ${dim.layer}</span></div>
        <p style="font-size:11px;color:var(--fg2);margin-top:4px">Del to delete</p>`;
      if (propsEl) propsEl.style.display = 'none';
      return;
    }
  }

  if (sel.length === 0) {
    infoEl.innerHTML = '<p class="muted">No selection</p>';
    if (propsEl) propsEl.style.display = 'none';
    return;
  }

  const ids = new Set(sel.map((s) => s.shapeId));
  const shapes = state.shapes.filter((s) => ids.has(s.id));

  const f = (v: number) => UnitConverter.formatOutput(v, unit, true);

  if (shapes.length === 1) {
    const bb = polygonBbox(shapes[0]);
    const a = polygonArea(shapes[0]);
    const areaStr = unit === 'mm' ? (a / 1000000).toFixed(4) + ' mm²' : Math.round(a).toLocaleString() + ' µm²';
    infoEl.innerHTML = `<div class="shape-info">
      <span>W: ${f(bb.maxX - bb.minX)}</span>
      <span>H: ${f(bb.maxY - bb.minY)}</span>
      <span>Area: ${areaStr}</span>
    </div>`;
  } else {
    let totalArea = 0;
    let combinedMinX = Infinity, combinedMinY = Infinity, combinedMaxX = -Infinity, combinedMaxY = -Infinity;
    for (const shape of shapes) {
      const bb = polygonBbox(shape);
      totalArea += polygonArea(shape);
      if (bb.minX < combinedMinX) combinedMinX = bb.minX;
      if (bb.minY < combinedMinY) combinedMinY = bb.minY;
      if (bb.maxX > combinedMaxX) combinedMaxX = bb.maxX;
      if (bb.maxY > combinedMaxY) combinedMaxY = bb.maxY;
    }
    const totalAreaStr = unit === 'mm' ? (totalArea / 1000000).toFixed(4) + ' mm²' : Math.round(totalArea).toLocaleString() + ' µm²';
    infoEl.innerHTML = `<p><strong>${shapes.length} shapes</strong></p>
      <div class="shape-info">
        <span>W: ${f(combinedMaxX - combinedMinX)}</span>
        <span>H: ${f(combinedMaxY - combinedMinY)}</span>
        <span>Total area: ${totalAreaStr}</span>
      </div>`;
  }

  // Show numeric inputs for single-shape selection
  if (propsEl) {
    if (shapes.length === 1) {
      propsEl.style.display = '';
      const bb = polygonBbox(shapes[0]);
      const px = document.getElementById('prop-x') as HTMLInputElement | null;
      const py = document.getElementById('prop-y') as HTMLInputElement | null;
      const pw = document.getElementById('prop-w') as HTMLInputElement | null;
      const ph = document.getElementById('prop-h') as HTMLInputElement | null;
      if (px && document.activeElement !== px) px.value = UnitConverter.formatOutput(bb.minX, unit);
      if (py && document.activeElement !== py) py.value = UnitConverter.formatOutput(bb.minY, unit);
      if (pw && document.activeElement !== pw) pw.value = UnitConverter.formatOutput(bb.maxX - bb.minX, unit);
      if (ph && document.activeElement !== ph) ph.value = UnitConverter.formatOutput(bb.maxY - bb.minY, unit);
    } else {
      propsEl.style.display = 'none';
    }
  }
}

export interface UnitUIDeps {
  getActiveTool(): unknown;
  textCapHeightUm: number;
  textLetterSpacingUm: number;
  annotationHeightUm: number;
  filletRadius: number;
  drcMinApertureUm: number;
  drcMinSpacingUm: number;
  duplicatePitchX: number;
  duplicatePitchY: number;
  refreshRightPanel(): void;
}

export function updateUnitUI(state: AppState, deps: UnitUIDeps): void {
  const unit = state.displayUnit;
  const isMm = unit === 'mm';
  const activeTool = deps.getActiveTool();

  const unitEl = document.getElementById('footer-unit');
  if (unitEl) unitEl.textContent = unit === 'um' ? 'µm' : unit;

  document.querySelectorAll('.unit-label').forEach((el) => {
    el.textContent = unit === 'mm' ? 'mm' : 'µm';
  });

  const displayUnitLabel = unit === 'um' ? 'µm' : unit;
  document.querySelectorAll('.duplicate-modal-pitch-label').forEach((el) => { el.textContent = `Pitch (${displayUnitLabel})`; });

  const inputs = document.querySelectorAll('input[type="number"]');
  inputs.forEach((input) => {
    const el = input as HTMLInputElement;
    if (el.id.includes('nx') || el.id.includes('ny')) return;
    if (el.id === 'drc-min-aperture' || el.id === 'drc-min-spacing') {
      el.step = isMm ? '0.01' : '10';
    } else if (el.id === 'fillet-r' || el.id.includes('pitch') || el.id.includes('modal-x') || el.id.includes('modal-y')) {
      el.step = isMm ? '0.1' : '100';
    } else if (el.id === 'rect-x' || el.id === 'rect-y' || el.id === 'rect-w' || el.id === 'rect-h'
             || el.id === 'circle-x' || el.id === 'circle-y' || el.id === 'circle-d') {
      el.step = isMm ? '0.1' : '100';
      el.min = isMm ? '0.001' : '1';
    } else if (el.id === 'text-size') {
      el.step = isMm ? '0.5' : '500';
      el.min = isMm ? '0.1' : '100';
    } else if (el.id === 'text-spacing') {
      el.step = isMm ? '0.1' : '100';
      el.min = '0';
    } else {
      el.step = isMm ? '0.001' : '1';
    }
  });

  if (activeTool instanceof RectTool) {
    const rxIn = document.getElementById('rect-x') as HTMLInputElement | null;
    if (rxIn) rxIn.value = UnitConverter.formatOutput(activeTool.getPlaceX(), unit);
    const ryIn = document.getElementById('rect-y') as HTMLInputElement | null;
    if (ryIn) ryIn.value = UnitConverter.formatOutput(activeTool.getPlaceY(), unit);
    const rwIn = document.getElementById('rect-w') as HTMLInputElement | null;
    if (rwIn) rwIn.value = UnitConverter.formatOutput(activeTool.getWidth(), unit);
    const rhIn = document.getElementById('rect-h') as HTMLInputElement | null;
    if (rhIn) rhIn.value = UnitConverter.formatOutput(activeTool.getHeight(), unit);
  }
  if (activeTool instanceof CircleTool) {
    const cxIn = document.getElementById('circle-x') as HTMLInputElement | null;
    if (cxIn) cxIn.value = UnitConverter.formatOutput(activeTool.getPlaceX(), unit);
    const cyIn = document.getElementById('circle-y') as HTMLInputElement | null;
    if (cyIn) cyIn.value = UnitConverter.formatOutput(activeTool.getPlaceY(), unit);
    const cdIn = document.getElementById('circle-d') as HTMLInputElement | null;
    if (cdIn) cdIn.value = UnitConverter.formatOutput(activeTool.getDiameter(), unit);
  }

  const textSizeIn = document.getElementById('text-size') as HTMLInputElement | null;
  if (textSizeIn) textSizeIn.value = UnitConverter.formatOutput(deps.textCapHeightUm, unit);
  const textSpacingIn = document.getElementById('text-spacing') as HTMLInputElement | null;
  if (textSpacingIn) textSpacingIn.value = UnitConverter.formatOutput(deps.textLetterSpacingUm, unit);
  const annSizeIn = document.getElementById('ann-size') as HTMLInputElement | null;
  if (annSizeIn) annSizeIn.value = UnitConverter.formatOutput(deps.annotationHeightUm, unit);

  const filletRInput = document.getElementById('fillet-r') as HTMLInputElement | null;
  if (filletRInput) filletRInput.value = UnitConverter.formatOutput(deps.filletRadius, unit);

  const drcAInput = document.getElementById('drc-min-aperture') as HTMLInputElement | null;
  if (drcAInput) drcAInput.value = UnitConverter.formatOutput(deps.drcMinApertureUm, unit);

  const drcSInput = document.getElementById('drc-min-spacing') as HTMLInputElement | null;
  if (drcSInput) drcSInput.value = UnitConverter.formatOutput(deps.drcMinSpacingUm, unit);

  const dupPxIn = document.getElementById('duplicate-modal-px') as HTMLInputElement | null;
  if (dupPxIn) dupPxIn.value = UnitConverter.formatOutput(deps.duplicatePitchX, unit);
  const dupPyIn = document.getElementById('duplicate-modal-py') as HTMLInputElement | null;
  if (dupPyIn) dupPyIn.value = UnitConverter.formatOutput(deps.duplicatePitchY, unit);

  deps.refreshRightPanel();
}
