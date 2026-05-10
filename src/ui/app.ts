import type { AppState, Layer, Point, Selection, ToolType } from '../types';
import { createDefaultState, canvasToWorld } from '../types';
import { History } from '../state/history';
import { CanvasRenderer } from '../canvas/renderer';
import { SelectTool } from '../tools/select';
import { RectTool } from '../tools/rect';
import { CircleTool } from '../tools/circle';
import { FilletTool } from '../tools/fillet';
import { PolygonTool } from '../tools/polygon';
import { MeasureTool } from '../tools/measure';
import { DimensionTool } from '../tools/dimension';
import { CenterlineTool } from '../tools/centerline';
import { findSnapPoint, hitTest, hitTestDimension } from '../core/selection';
import {
  AddShapeCommand, DeleteCommand, UnionCommand, DifferenceCommand,
  ArrayCopyCommand, CopyCommand, MoveCommand, ResizeCommand,
  AddLayerCommand, DeleteLayerCommand, RenameLayerCommand,
  UpdateLayerStyleCommand, MoveShapesToLayerCommand,
  DeleteDimensionCommand,
} from '../state/commands';
import { loadState, saveState, startAutosave, clearState, markDirty, loadPrefs, savePrefs } from '../state/autosave';
import { importDxf, type ImportResult } from '../dxf/importer';
import { downloadDxf } from '../dxf/exporter';
import { polygonArea, polygonBbox } from '../core/geometry';
import { resizePolygon } from '../core/transform';
import { resolveDimension } from '../core/dimension-resolve';
import { runDrc, DEFAULT_DRC_CONFIG, type DrcConfig } from '../core/drc';
import type { DrcError } from '../types';
import { fmtMm } from '../core/format';

type AnyTool = SelectTool | RectTool | CircleTool | FilletTool | PolygonTool | MeasureTool | DimensionTool | CenterlineTool;

function computeNiceGridSize(zoom: number): number {
  const targetPx = 60;
  const exp = Math.floor(Math.log10(targetPx / zoom));
  const base = Math.pow(10, exp);
  for (const n of [1, 2, 5, 10]) {
    const s = n * base;
    if (s * zoom >= targetPx) return Math.max(1, Math.round(s));
  }
  return Math.max(1, Math.round(10 * base));
}

export class App {
  private history: History;
  private renderer: CanvasRenderer;
  private canvas: HTMLCanvasElement;
  private isDark = true;
  private activeTool: AnyTool;
  private isPanning = false;
  private panStart: { x: number; y: number } | null = null;
  private panOrigin: { x: number; y: number } | null = null;
  private stopAutosave: (() => void) | null = null;
  private animFrame: number | null = null;
  private pendingRender = false;
  private filletRadius = 500;
  private drcConfig: DrcConfig = { ...DEFAULT_DRC_CONFIG };
  private drcErrors: DrcError[] = [];
  private diffStep: 0 | 1 | 2 = 0;
  private diffBaseId: string | null = null;
  private selectedDimId: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.history = new History(createDefaultState());
    this.renderer = new CanvasRenderer(canvas, this.isDark);

    const toolCtx = {
      history: this.history,
      getSnapPoint: (worldPt: Point) => this.getSnapPoint(worldPt),
      requestRender: () => this.requestRender(),
    };
    this.activeTool = new SelectTool(toolCtx);
  }

  async init(): Promise<void> {
    // Restore saved state and preferences
    try {
      const [saved, prefs] = await Promise.all([loadState(), loadPrefs()]);
      if (saved) this.history.loadState(saved);
      this.history.state.gridSize = computeNiceGridSize(this.history.state.zoom);
      this.filletRadius = prefs.filletRadius;
      const rInput = document.getElementById('fillet-r') as HTMLInputElement | null;
      if (rInput) rInput.value = String(this.filletRadius);
      this.drcConfig = { minApertureUm: prefs.drcMinApertureUm, minSpacingUm: prefs.drcMinSpacingUm };
      const aInput = document.getElementById('drc-min-aperture') as HTMLInputElement | null;
      const sInput = document.getElementById('drc-min-spacing') as HTMLInputElement | null;
      if (aInput) aInput.value = String(this.drcConfig.minApertureUm);
      if (sInput) sInput.value = String(this.drcConfig.minSpacingUm);
    } catch {
      // Ignore load errors
    }

    this.renderer.resize();
    this.setupEventListeners();
    this.stopAutosave = startAutosave(() => this.history.state);
    this.requestRender();

    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.requestRender();
    });

    window.addEventListener('beforeunload', () => {
      void saveState(this.history.state);
    });
  }

  private getSnapPoint(worldPt: Point): Point {
    const state = this.history.state;
    if (!state.snapEnabled) return worldPt;
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const interactiveShapes = state.shapes.filter((s) => {
      const l = layerMap.get(s.layer);
      return l && l.visible;
    });
    const subGs = state.gridSize / 5;
    const effectiveGrid = subGs * state.zoom >= 8 ? subGs : state.gridSize;
    return findSnapPoint(
      worldPt,
      interactiveShapes,
      effectiveGrid,
      state.snapRadius / state.zoom
    );
  }

  private requestRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    this.animFrame = requestAnimationFrame(() => {
      this.pendingRender = false;
      this.doRender();
    });
  }

  private doRender(): void {
    const state = this.history.state;
    this.drcErrors = runDrc(state.shapes, state.layers, this.drcConfig);
    const rubberBand = this.activeTool instanceof SelectTool
      ? (this.activeTool.getRubberBand() ?? undefined)
      : undefined;
    const filletStatuses = this.activeTool instanceof FilletTool
      ? this.activeTool.getVertexStatuses()
      : undefined;
    this.renderer.render(
      state,
      this.activeTool.getDraft() ?? undefined,
      this.activeTool.getSnapPoint() ?? undefined,
      this.activeTool.showsAllVertices(),
      rubberBand,
      filletStatuses,
      this.drcErrors,
      this.diffStep === 2 ? (this.diffBaseId ?? undefined) : undefined,
      {
        measureOverlay: this.activeTool instanceof MeasureTool
          ? (this.activeTool.getMeasureOverlay() ?? undefined) : undefined,
        dimDraft: this.activeTool instanceof DimensionTool
          ? (this.activeTool.getDimDraft() ?? undefined)
          : this.activeTool instanceof CenterlineTool
            ? (this.activeTool.getDimDraft(state) ?? undefined)
            : undefined,
        selectedDimId: this.selectedDimId,
      },
    );
    this.updateFooter(state);
    this.updateRightPanel(state);
    this.updateUndoButtons();
  }

  private setupEventListeners(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));

    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Toolbar buttons
    document.querySelectorAll('[data-tool]').forEach((el) => {
      el.addEventListener('click', () => {
        this.setTool(el.getAttribute('data-tool') as ToolType);
      });
    });

    // Action buttons
    document.getElementById('btn-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => this.redo());
    document.getElementById('btn-delete')?.addEventListener('click', () => this.deleteSelected());
    document.getElementById('btn-union')?.addEventListener('click', () => this.doUnion());
    document.getElementById('btn-difference')?.addEventListener('click', () => this.doDifference());
    document.getElementById('btn-copy-btn')?.addEventListener('click', () => this.doCopy());
    document.getElementById('btn-array')?.addEventListener('click', () => this.doArray());
    document.getElementById('btn-import')?.addEventListener('click', () => this.importDxf());
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportDxf());
    document.getElementById('btn-clear')?.addEventListener('click', () => this.hardReset());
    document.getElementById('btn-theme')?.addEventListener('click', () => this.toggleTheme());
    document.getElementById('btn-snap')?.addEventListener('click', () => this.toggleSnap());
    document.getElementById('btn-fit')?.addEventListener('click', () => this.fitToContent());
    document.getElementById('footer-zoom')?.addEventListener('click', () => this.resetZoom());

    // Layer panel buttons
    document.getElementById('btn-layer-add')?.addEventListener('click', () => this.addLayer());
    document.getElementById('btn-layer-move-shapes')?.addEventListener('click', () => this.moveSelectedToActiveLayer());

    // Fillet panel
    const filletRInput = document.getElementById('fillet-r') as HTMLInputElement | null;
    filletRInput?.addEventListener('input', () => {
      const r = parseInt(filletRInput.value, 10);
      if (isNaN(r) || r <= 0) return;
      this.filletRadius = r;
      savePrefs({ filletRadius: r }).catch(() => {});
      if (this.activeTool instanceof FilletTool) {
        this.activeTool.setRadius(r, this.history.state);
      }
    });
    document.getElementById('btn-fillet-all')?.addEventListener('click', () => {
      if (this.activeTool instanceof FilletTool) {
        this.activeTool.applyToAllCorners(this.history.state);
      }
    });

    // Numeric properties panel
    const propX = document.getElementById('prop-x') as HTMLInputElement | null;
    const propY = document.getElementById('prop-y') as HTMLInputElement | null;
    const propW = document.getElementById('prop-w') as HTMLInputElement | null;
    const propH = document.getElementById('prop-h') as HTMLInputElement | null;

    const applyPropXY = () => {
      const state = this.history.state;
      if (!propX || !propY) return;
      const ids = new Set(state.selection.map((s) => s.shapeId));
      const shapes = state.shapes.filter((s) => ids.has(s.id));
      if (shapes.length !== 1) return;
      const bb = polygonBbox(shapes[0]);
      const newX = parseInt(propX.value, 10);
      const newY = parseInt(propY.value, 10);
      if (isNaN(newX) || isNaN(newY)) return;
      const dx = newX - bb.minX;
      const dy = newY - bb.minY;
      if (dx === 0 && dy === 0) return;
      this.history.execute(new MoveCommand(state.selection, dx, dy));
      markDirty();
      this.requestRender();
    };

    const applyPropWH = () => {
      const state = this.history.state;
      if (!propW || !propH) return;
      const ids = new Set(state.selection.map((s) => s.shapeId));
      const shapes = state.shapes.filter((s) => ids.has(s.id));
      if (shapes.length !== 1) return;
      const bb = polygonBbox(shapes[0]);
      const newW = parseInt(propW.value, 10);
      const newH = parseInt(propH.value, 10);
      if (isNaN(newW) || isNaN(newH) || newW < 1 || newH < 1) return;
      if (newW === bb.maxX - bb.minX && newH === bb.maxY - bb.minY) return;
      const resized = resizePolygon(shapes[0], bb.minX, bb.minY, newW, newH);
      this.history.execute(new ResizeCommand(shapes[0], resized));
      markDirty();
      this.requestRender();
    };

    propX?.addEventListener('change', applyPropXY);
    propY?.addEventListener('change', applyPropXY);
    propW?.addEventListener('change', applyPropWH);
    propH?.addEventListener('change', applyPropWH);

    // DRC config
    const drcApertureInput = document.getElementById('drc-min-aperture') as HTMLInputElement | null;
    const drcSpacingInput = document.getElementById('drc-min-spacing') as HTMLInputElement | null;
    drcApertureInput?.addEventListener('change', () => {
      const v = parseInt(drcApertureInput.value, 10);
      if (!isNaN(v) && v > 0) {
        this.drcConfig = { ...this.drcConfig, minApertureUm: v };
        savePrefs({ drcMinApertureUm: v }).catch(() => {});
        this.requestRender();
      }
    });
    drcSpacingInput?.addEventListener('change', () => {
      const v = parseInt(drcSpacingInput.value, 10);
      if (!isNaN(v) && v >= 0) {
        this.drcConfig = { ...this.drcConfig, minSpacingUm: v };
        savePrefs({ drcMinSpacingUm: v }).catch(() => {});
        this.requestRender();
      }
    });

    // File input
    const fileInput = document.getElementById('dxf-file-input') as HTMLInputElement | null;
    fileInput?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadDxfFile(file);
    });
  }

  private getCanvasPt(e: MouseEvent): { canvasPt: Point; worldPt: Point } {
    const rect = this.canvas.getBoundingClientRect();
    const canvasPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const state = this.history.state;
    const worldPt = canvasToWorld(canvasPt.x, canvasPt.y, state);
    return { canvasPt, worldPt };
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 2 || (e.button === 1)) {
      // Right or middle: pan
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY };
      const state = this.history.state;
      this.panOrigin = { x: state.panX, y: state.panY };
      return;
    }

    const { canvasPt, worldPt } = this.getCanvasPt(e);
    if (this.diffStep > 0) { this.handleDiffClick(canvasPt); return; }

    // When select tool is active, check dim hits before polygons
    if (this.activeTool instanceof SelectTool) {
      const state = this.history.state;
      const dimHit = hitTestDimension(canvasPt.x, canvasPt.y, state.dimensions, state.shapes, state, state.snapRadius);
      if (dimHit) {
        this.selectedDimId = dimHit.id;
        state.selection = [];
        this.requestRender();
        return;
      }
      // No dim hit — clear dim selection
      this.selectedDimId = null;
    }

    this.activeTool.onMouseDown(worldPt, canvasPt, e.shiftKey, this.history.state);
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.isPanning && this.panStart && this.panOrigin) {
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      const state = this.history.state;
      // Mutate view state directly (not a command - view state is not undoable)
      (state as AppState).panX = this.panOrigin.x + dx;
      (state as AppState).panY = this.panOrigin.y + dy;
      this.requestRender();
      return;
    }

    const { canvasPt, worldPt } = this.getCanvasPt(e);
    if (this.diffStep === 0) this.activeTool.onMouseMove(worldPt, canvasPt, e.shiftKey, this.history.state);

    // Update cursor position in footer
    const cursorX = document.getElementById('footer-cx');
    const cursorY = document.getElementById('footer-cy');
    if (cursorX) cursorX.textContent = String(worldPt.x);
    if (cursorY) cursorY.textContent = String(worldPt.y);
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.isPanning) {
      this.isPanning = false;
      this.panStart = null;
      this.panOrigin = null;
      return;
    }

    const { canvasPt, worldPt } = this.getCanvasPt(e);
    if (this.diffStep === 0) this.activeTool.onMouseUp(worldPt, canvasPt, e.shiftKey, this.history.state);
  }

  private onDblClick(_e: MouseEvent): void {
    if (!(this.activeTool instanceof PolygonTool)) return;
    // Double-click fires mousedown twice before dblclick; the second mousedown already
    // added a duplicate vertex — remove it, then commit with what we have.
    (this.activeTool as PolygonTool).commitFromDblClick(this.history.state);
  }

  private setZoom(newZoom: number, anchorCanvasX?: number, anchorCanvasY?: number): void {
    const state = this.history.state;
    const z = Math.max(0.01, Math.min(50, newZoom));
    if (anchorCanvasX !== undefined && anchorCanvasY !== undefined) {
      state.panX = anchorCanvasX - (anchorCanvasX - state.panX) * (z / state.zoom);
      state.panY = anchorCanvasY - (anchorCanvasY - state.panY) * (z / state.zoom);
    }
    state.zoom = z;
    state.gridSize = computeNiceGridSize(z);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const state = this.history.state;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.setZoom(state.zoom * factor, mx, my);
    this.requestRender();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { e.preventDefault(); this.undo(); return; }
      if (e.key === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.key === 's') { e.preventDefault(); saveState(this.history.state); return; }
    }
    const target = e.target as HTMLElement;
    const inInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (!inInput && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'v' || e.key === 'V') { this.setTool('select'); return; }
      if (e.key === 'r' || e.key === 'R') { this.setTool('rect'); return; }
      if (e.key === 'c' || e.key === 'C') { this.setTool('circle'); return; }
      if (e.key === 'p' || e.key === 'P') { this.setTool('polygon'); return; }
      if (e.key === 'f' || e.key === 'F') { this.setTool('fillet'); return; }
      if (e.key === 'm' || e.key === 'M') { this.setTool('measure'); return; }
      if (e.key === 'd' || e.key === 'D') { this.setTool('dimension'); return; }
      if (e.key === 'l' || e.key === 'L') { this.setTool('centerline'); return; }
      if (e.key === 'Home') { e.preventDefault(); this.fitToContent(); return; }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // PolygonTool in progress consumes Backspace to pop the last vertex
      if (!inInput && this.activeTool instanceof PolygonTool && this.activeTool.isDrawing()) {
        // handled by onKeyDown below
      } else if (!inInput) {
        this.deleteSelected();
      }
    }
    if (e.key === 'Escape') { this.cancelDiffMode(); this.activeTool.cancel(); }
    this.activeTool.onKeyDown(e.key, this.history.state);
  }

  setTool(tool: ToolType): void {
    this.cancelDiffMode();
    this.activeTool.cancel();
    const toolCtx = {
      history: this.history,
      getSnapPoint: (worldPt: Point) => this.getSnapPoint(worldPt),
      requestRender: () => this.requestRender(),
    };

    // Update active tool state
    const state = this.history.state;
    state.activeTool = tool;

    switch (tool) {
      case 'select': case 'move': this.activeTool = new SelectTool(toolCtx); break;
      case 'rect': this.activeTool = new RectTool(toolCtx); break;
      case 'circle': this.activeTool = new CircleTool(toolCtx); break;
      case 'polygon': this.activeTool = new PolygonTool(toolCtx); break;
      case 'fillet': this.activeTool = new FilletTool(toolCtx, this.filletRadius); break;
      case 'measure': this.activeTool = new MeasureTool(toolCtx); break;
      case 'dimension': this.activeTool = new DimensionTool(toolCtx); break;
      case 'centerline': this.activeTool = new CenterlineTool(toolCtx); break;
      default: this.activeTool = new SelectTool(toolCtx);
    }

    // Update toolbar highlight
    document.querySelectorAll('[data-tool]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-tool') === tool);
    });

    this.requestRender();
  }

  undo(): void {
    this.history.undo();
    this.requestRender();
  }

  redo(): void {
    this.history.redo();
    this.requestRender();
  }

  deleteSelected(): void {
    if (this.selectedDimId !== null) {
      const id = this.selectedDimId;
      this.selectedDimId = null;
      this.history.execute(new DeleteDimensionCommand(id));
      markDirty();
      this.requestRender();
      return;
    }
    const state = this.history.state;
    if (state.selection.length === 0) return;
    this.history.execute(new DeleteCommand(state.selection));
    markDirty();
    this.requestRender();
  }

  doUnion(): void {
    const state = this.history.state;
    const sel = state.selection;
    if (sel.length < 2) { alert('Select at least 2 shapes for Union'); return; }
    this.history.execute(new UnionCommand(sel));
    markDirty();
    this.requestRender();
  }

  doDifference(): void {
    this.cancelDiffMode();
    this.diffStep = 1;
    this.history.state.selection = [];
    this.canvas.style.cursor = 'crosshair';
    document.getElementById('btn-difference')?.classList.add('active');
    this.requestRender();
  }

  private cancelDiffMode(): void {
    if (this.diffStep === 0) return;
    this.diffStep = 0;
    this.diffBaseId = null;
    this.canvas.style.cursor = '';
    document.getElementById('btn-difference')?.classList.remove('active');
    this.requestRender();
  }

  private handleDiffClick(canvasPt: Point): void {
    const state = this.history.state;
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const interactiveShapes = state.shapes.filter((s) => {
      const l = layerMap.get(s.layer);
      return l && l.visible && !l.locked;
    });
    const hit = hitTest(canvasPt.x, canvasPt.y, interactiveShapes, state, state.snapRadius);
    if (!hit || hit.type !== 'polygon') return;

    if (this.diffStep === 1) {
      this.diffBaseId = hit.shapeId;
      this.diffStep = 2;
      this.requestRender();
    } else if (this.diffStep === 2 && this.diffBaseId !== null) {
      if (hit.shapeId === this.diffBaseId) return;
      const baseSel: Selection = { type: 'polygon', shapeId: this.diffBaseId, index: -1, holeIndex: -1 };
      const cutSel: Selection = { type: 'polygon', shapeId: hit.shapeId, index: -1, holeIndex: -1 };
      this.history.execute(new DifferenceCommand(baseSel, cutSel));
      markDirty();
      this.diffStep = 0;
      this.diffBaseId = null;
      this.canvas.style.cursor = '';
      document.getElementById('btn-difference')?.classList.remove('active');
      this.requestRender();
    }
  }

  doCopy(): void {
    const state = this.history.state;
    if (state.selection.length === 0) return;
    const offsetDialog = prompt('Copy offset X,Y (µm):', '1000,0');
    if (!offsetDialog) return;
    const parts = offsetDialog.split(',').map((s) => parseInt(s.trim(), 10));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return;
    this.history.execute(new CopyCommand(state.selection, parts[0], parts[1]));
    markDirty();
    this.requestRender();
  }

  doArray(): void {
    const state = this.history.state;
    if (state.selection.length === 0) { alert('Select shapes first'); return; }
    const input = prompt('Array: nx,ny,pitchX,pitchY (µm)\nExample: 3,4,2000,2000', '3,3,2000,2000');
    if (!input) return;
    const parts = input.split(',').map((s) => parseInt(s.trim(), 10));
    if (parts.length !== 4 || parts.some(isNaN)) { alert('Invalid input'); return; }
    const [nx, ny, pitchX, pitchY] = parts;
    this.history.execute(new ArrayCopyCommand(state.selection, nx, ny, pitchX, pitchY));
    markDirty();
    this.requestRender();
  }

  async importDxf(): Promise<void> {
    document.getElementById('dxf-file-input')?.click();
  }

  private async loadDxfFile(file: File): Promise<void> {
    const text = await file.text();
    try {
      const result = await importDxf(text);
      await this.showImportDialog(result);
    } catch (e) {
      alert(`DXF import failed: ${e}`);
    }
  }

  private async showImportDialog(result: ImportResult): Promise<void> {
    const modal = document.getElementById('dxf-import-modal') as HTMLElement;
    const layersDiv = document.getElementById('dxf-import-layers') as HTMLElement;
    const okBtn = document.getElementById('dxf-import-ok') as HTMLButtonElement;
    const cancelBtn = document.getElementById('dxf-import-cancel') as HTMLButtonElement;

    // Build layer list with checkboxes
    layersDiv.innerHTML = '';
    for (const layer of result.layers) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = layer.name;
      const swatch = document.createElement('span');
      swatch.style.cssText = `display:inline-block;width:12px;height:12px;background:${layer.color};border:1px solid #555`;
      const shapeCount = result.polygons.filter((p) => p.layer === layer.name).length;
      label.appendChild(cb);
      label.appendChild(swatch);
      label.appendChild(document.createTextNode(` ${layer.name} (${shapeCount} shapes)`));
      layersDiv.appendChild(label);
    }

    // Show ignored entity counts if any
    const ignored = Object.entries(result.ignoredCounts);
    if (ignored.length > 0) {
      const note = document.createElement('p');
      note.style.cssText = 'font-size:11px;color:var(--fg2);margin-top:8px';
      note.textContent = 'Ignored: ' + ignored.map(([t, c]) => `${c} ${t}`).join(', ');
      layersDiv.appendChild(note);
    }

    modal.style.display = '';

    return new Promise<void>((resolve) => {
      const cleanup = () => {
        modal.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
      };

      const onOk = () => {
        cleanup();
        const checkedNames = new Set(
          [...layersDiv.querySelectorAll('input[type=checkbox]:checked')].map(
            (el) => (el as HTMLInputElement).value
          )
        );

        // Merge with existing layers: only add new layer names
        const state = this.history.state;
        const existingNames = new Set(state.layers.map((l) => l.name));

        for (const layer of result.layers) {
          if (!existingNames.has(layer.name)) {
            const newLayer: Layer = { ...layer, isAperture: checkedNames.has(layer.name) };
            this.history.execute(new AddLayerCommand(newLayer));
          }
          // Preserve existing layer settings (including isAperture)
        }

        for (const poly of result.polygons) {
          this.history.execute(new AddShapeCommand(poly));
        }
        markDirty();
        this.requestRender();
        resolve();
      };

      const onCancel = () => {
        cleanup();
        resolve();
      };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  private panToWorld(wx: number, wy: number): void {
    const state = this.history.state;
    state.panX = Math.round(this.canvas.width / 2 - wx * state.zoom);
    state.panY = Math.round(this.canvas.height / 2 - wy * state.zoom);
    this.requestRender();
  }

  fitToContent(): void {
    const state = this.history.state;
    const RULER = 24;
    const viewW = this.canvas.width - RULER;
    const viewH = this.canvas.height - RULER;

    if (state.shapes.length === 0 && state.dimensions.length === 0) {
      this.setZoom(0.5);
      state.panX = Math.round(RULER + viewW / 2);
      state.panY = Math.round(RULER + viewH / 2);
      this.requestRender();
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const expandBbox = (x: number, y: number) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    };
    for (const s of state.shapes) {
      const bb = polygonBbox(s);
      expandBbox(bb.minX, bb.minY);
      expandBbox(bb.maxX, bb.maxY);
    }
    for (const d of state.dimensions) {
      const { p1, p2 } = resolveDimension(d, state.shapes);
      expandBbox(p1.x, p1.y);
      expandBbox(p2.x, p2.y);
    }

    const contentW = maxX - minX || 1;
    const contentH = maxY - minY || 1;
    const z = Math.min(viewW / (contentW * 1.2), viewH / (contentH * 1.2), 50);
    this.setZoom(z);
    state.panX = Math.round(RULER + viewW / 2 - ((minX + maxX) / 2) * z);
    state.panY = Math.round(RULER + viewH / 2 - ((minY + maxY) / 2) * z);
    this.requestRender();
  }

  private resetZoom(): void {
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    this.setZoom(1, cx, cy);
    this.requestRender();
  }

  exportDxf(): void {
    const state = this.history.state;
    downloadDxf(state.shapes, state.layers);
  }

  async hardReset(): Promise<void> {
    if (!confirm('Clear all shapes and history?')) return;
    this.cancelDiffMode();
    this.selectedDimId = null;
    await clearState();
    this.history.loadState(createDefaultState());
    this.requestRender();
  }

  toggleTheme(): void {
    this.isDark = !this.isDark;
    this.renderer.setTheme(this.isDark);
    document.body.classList.toggle('light', !this.isDark);
    this.requestRender();
  }

  toggleSnap(): void {
    const state = this.history.state;
    state.snapEnabled = !state.snapEnabled;
    const btn = document.getElementById('btn-snap');
    if (btn) btn.classList.toggle('active', state.snapEnabled);
    this.requestRender();
  }

  // ─── Layer panel ────────────────────────────────────────────────────────────

  private renderLayerPanel(state: AppState): void {
    const listEl = document.getElementById('layer-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    for (const layer of state.layers) {
      const isActive = layer.name === state.activeLayerName;
      const row = document.createElement('div');
      row.className = 'layer-row' + (isActive ? ' is-active' : '') + (layer.isAperture ? ' is-aperture' : '');
      row.dataset.layer = layer.name;

      row.innerHTML = `
        <span class="lyr-active" title="Set active">${isActive ? '●' : '○'}</span>
        <input type="color" class="lyr-color" value="${layer.color}" title="Layer color">
        <span class="lyr-name" title="${layer.name}">${layer.name}</span>
        <button class="lyr-btn lyr-vis${isActive ? ' lyr-btn-disabled' : ''}" title="${isActive ? 'Active layer cannot be hidden' : 'Toggle visibility'}">${layer.visible ? 'V' : 'H'}</button>
        <button class="lyr-btn lyr-apt${layer.isAperture ? ' on' : ''}${layer.name === 'DIMENSIONS' ? ' lyr-btn-disabled' : ''}" title="${layer.name === 'DIMENSIONS' ? 'DIMENSIONS layer is never an aperture' : 'Toggle aperture (DRC + DXF export)'}">A</button>
        <button class="lyr-btn lyr-del" title="Delete layer">×</button>
      `;

      row.querySelector('.lyr-active')?.addEventListener('click', () => this.setActiveLayer(layer.name));
      row.querySelector('.lyr-name')?.addEventListener('dblclick', () => this.renameLayer(layer.name));
      row.querySelector('.lyr-name')?.addEventListener('click', () => this.setActiveLayer(layer.name));

      const colorInput = row.querySelector('.lyr-color') as HTMLInputElement;
      colorInput.addEventListener('change', () => {
        this.history.execute(new UpdateLayerStyleCommand(layer.name, { color: colorInput.value }));
        markDirty();
        this.requestRender();
      });

      row.querySelector('.lyr-vis')?.addEventListener('click', () => {
        this.toggleLayerVisible(layer.name);
      });
      row.querySelector('.lyr-apt')?.addEventListener('click', () => {
        this.history.execute(new UpdateLayerStyleCommand(layer.name, { isAperture: !layer.isAperture }));
        markDirty();
        this.requestRender();
      });
      row.querySelector('.lyr-del')?.addEventListener('click', () => {
        this.deleteLayer(layer.name);
      });

      listEl.appendChild(row);
    }
  }

  private setActiveLayer(name: string): void {
    const state = this.history.state;
    const layer = state.layers.find((l) => l.name === name);
    if (!layer) return;
    state.activeLayerName = name;
    // Active layer must be visible
    if (!layer.visible) {
      state.layers = state.layers.map((l) => l.name === name ? { ...l, visible: true } : l);
    }
    this.requestRender();
  }

  private toggleLayerVisible(name: string): void {
    const state = this.history.state;
    if (name === state.activeLayerName) return; // active layer cannot be hidden
    const layer = state.layers.find((l) => l.name === name);
    if (!layer) return;
    const wasVisible = layer.visible;
    state.layers = state.layers.map((l) => l.name === name ? { ...l, visible: !l.visible } : l);
    // Clear selection of shapes on a layer that just became hidden
    if (wasVisible) {
      const hiddenIds = new Set(state.shapes.filter((s) => s.layer === name).map((s) => s.id));
      state.selection = state.selection.filter((s) => !hiddenIds.has(s.shapeId));
    }
    this.requestRender();
  }

  private addLayer(): void {
    const name = prompt('New layer name:');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const state = this.history.state;
    if (state.layers.some((l) => l.name === trimmed)) {
      alert(`Layer "${trimmed}" already exists.`);
      return;
    }
    this.history.execute(new AddLayerCommand({
      name: trimmed, color: '#ffffff', linetype: 'CONTINUOUS',
      lineweight: -1, visible: true, locked: false, plot: true, isAperture: false,
    }));
    markDirty();
    this.requestRender();
  }

  private renameLayer(name: string): void {
    const newName = prompt('Rename layer:', name);
    if (!newName || !newName.trim() || newName.trim() === name) return;
    const trimmed = newName.trim();
    const state = this.history.state;
    if (state.layers.some((l) => l.name === trimmed)) {
      alert(`Layer "${trimmed}" already exists.`);
      return;
    }
    this.history.execute(new RenameLayerCommand(name, trimmed));
    markDirty();
    this.requestRender();
  }

  private deleteLayer(name: string): void {
    const state = this.history.state;
    if (state.layers.length <= 1) {
      alert('Cannot delete the last layer.');
      return;
    }
    const shapeCount = state.shapes.filter((s) => s.layer === name).length;
    if (shapeCount === 0) {
      if (!confirm(`Delete layer "${name}"?`)) return;
      this.history.execute(new DeleteLayerCommand(name, 'delete'));
      markDirty();
      this.requestRender();
      return;
    }
    // Show delete modal for non-empty layers
    const modal = document.getElementById('layer-delete-modal') as HTMLElement;
    const msg = document.getElementById('layer-delete-msg') as HTMLElement;
    const targetSel = document.getElementById('layer-delete-target') as HTMLSelectElement;
    const btnMove = document.getElementById('layer-delete-move') as HTMLButtonElement;
    const btnDel = document.getElementById('layer-delete-destroy') as HTMLButtonElement;
    const btnCancel = document.getElementById('layer-delete-cancel') as HTMLButtonElement;

    msg.textContent = `Layer "${name}" has ${shapeCount} shape(s).`;
    targetSel.innerHTML = state.layers
      .filter((l) => l.name !== name)
      .map((l) => `<option value="${l.name}">${l.name}</option>`)
      .join('');

    modal.style.display = '';
    const close = () => { modal.style.display = 'none'; };

    const onMove = () => {
      close();
      const target = targetSel.value;
      this.history.execute(new DeleteLayerCommand(name, 'move', target));
      markDirty();
      this.requestRender();
    };
    const onDel = () => {
      if (!confirm(`Delete layer "${name}" and its ${shapeCount} shape(s)?`)) return;
      close();
      this.history.execute(new DeleteLayerCommand(name, 'delete'));
      markDirty();
      this.requestRender();
    };

    btnMove.onclick = onMove;
    btnDel.onclick = onDel;
    btnCancel.onclick = close;
  }

  private moveSelectedToActiveLayer(): void {
    const state = this.history.state;
    if (state.selection.length === 0) return;
    this.history.execute(new MoveShapesToLayerCommand(state.selection, state.activeLayerName));
    markDirty();
    this.requestRender();
  }

  // ─── Right panel ────────────────────────────────────────────────────────────

  private updateFooter(state: AppState): void {
    const el = (id: string) => document.getElementById(id);
    const f = (v: number) => v.toLocaleString();

    if (this.diffStep > 0) {
      const hint = this.diffStep === 1 ? 'Click BASE (keeps)' : 'Click CUT (removes)';
      if (el('footer-w')) el('footer-w')!.textContent = 'Diff:';
      if (el('footer-h')) el('footer-h')!.textContent = hint;
      if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
    } else if (this.activeTool instanceof MeasureTool) {
      const ov = this.activeTool.getMeasureOverlay();
      if (ov) {
        const dx = Math.abs(ov.p2.x - ov.p1.x);
        const dy = Math.abs(ov.p2.y - ov.p1.y);
        const d = Math.round(Math.sqrt(dx * dx + dy * dy));
        if (el('footer-w')) el('footer-w')!.textContent = `dx:${fmtMm(dx)}`;
        if (el('footer-h')) el('footer-h')!.textContent = `dy:${fmtMm(dy)}`;
        if (el('footer-area')) el('footer-area')!.textContent = `d:${fmtMm(d)}`;
      } else {
        if (el('footer-w')) el('footer-w')!.textContent = 'Click p1';
        if (el('footer-h')) el('footer-h')!.textContent = '—';
        if (el('footer-area')) el('footer-area')!.textContent = 'Esc clear';
      }
    } else if (this.activeTool instanceof DimensionTool) {
      const steps = ['Click v1', 'Click v2', 'Click offset'];
      const step = this.activeTool.getStep() === 'v1' ? 0 : this.activeTool.getStep() === 'v2' ? 1 : 2;
      if (el('footer-w')) el('footer-w')!.textContent = 'Dim:';
      if (el('footer-h')) el('footer-h')!.textContent = steps[step];
      if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
    } else if (this.activeTool instanceof CenterlineTool) {
      const step = this.activeTool.getStep();
      if (el('footer-w')) el('footer-w')!.textContent = 'CL:';
      if (el('footer-h')) el('footer-h')!.textContent = step === 'edge1' ? 'Click edge 1' : 'Click edge 2';
      if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
    } else if (this.activeTool instanceof PolygonTool && this.activeTool.isDrawing()) {
      const n = (this.activeTool as PolygonTool).vertexCount();
      if (el('footer-w')) el('footer-w')!.textContent = `${n} pts`;
      if (el('footer-h')) el('footer-h')!.textContent = 'Enter/click①';
      if (el('footer-area')) el('footer-area')!.textContent = '⌫ undo  Esc cancel';
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
      if (el('footer-area')) el('footer-area')!.textContent = f(Math.round(a));
    }

    if (el('footer-grid')) el('footer-grid')!.textContent = `${state.gridSize}µm`;
    if (el('footer-snap')) el('footer-snap')!.textContent = state.snapEnabled ? 'ON' : 'OFF';
    if (el('footer-zoom')) el('footer-zoom')!.textContent = `${(state.zoom * 100).toFixed(0)}%`;
  }

  private updateRightPanel(state: AppState): void {
    // Show/hide fillet panel and sync its state
    const filletPanel = document.getElementById('fillet-panel');
    const isFilletActive = this.activeTool instanceof FilletTool;
    if (filletPanel) filletPanel.style.display = isFilletActive ? '' : 'none';
    if (isFilletActive) {
      const ft = this.activeTool as FilletTool;
      const rInput = document.getElementById('fillet-r') as HTMLInputElement | null;
      if (rInput) {
        const cur = parseInt(rInput.value, 10);
        if (cur !== ft.getRadius()) rInput.value = String(ft.getRadius());
      }
      const statusEl = document.getElementById('fillet-status');
      if (statusEl) statusEl.textContent = ft.getStatusMessage();
    }

    // DRC results (already computed in doRender, just display)
    const drcListEl = document.getElementById('drc-list');
    if (drcListEl) {
      const errors = this.drcErrors;
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
          if (loc) this.panToWorld(loc.x, loc.y);
        };
      }
    }

    // Layer panel
    this.renderLayerPanel(state);

    const sel = state.selection;
    const infoEl = document.getElementById('selection-info');
    const propsEl = document.getElementById('shape-props');
    if (!infoEl) return;

    // Dimension selected
    if (this.selectedDimId !== null) {
      const dim = state.dimensions.find((d) => d.id === this.selectedDimId);
      if (dim) {
        const { p1, p2, frozen } = resolveDimension(dim, state.shapes);
        let label: string;
        if (dim.kind === 'centerline') {
          const dx = Math.abs(p2.x - p1.x);
          const dy = Math.abs(p2.y - p1.y);
          const len = Math.round(Math.sqrt(dx * dx + dy * dy));
          label = `CL: ${fmtMm(len)}`;
        } else {
          const val = dim.kind === 'linear-h'
            ? fmtMm(Math.abs(p2.x - p1.x))
            : fmtMm(Math.abs(p2.y - p1.y));
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
    let totalArea = 0;
    let html = `<p><strong>${shapes.length} shape(s)</strong></p>`;

    for (const shape of shapes) {
      const bb = polygonBbox(shape);
      const a = polygonArea(shape);
      totalArea += a;
      html += `<div class="shape-info">
        <span>W: ${(bb.maxX - bb.minX).toLocaleString()}µm</span>
        <span>H: ${(bb.maxY - bb.minY).toLocaleString()}µm</span>
        <span>Area: ${Math.round(a).toLocaleString()}µm²</span>
      </div>`;
    }

    if (shapes.length > 1) {
      html += `<p>Total area: ${Math.round(totalArea).toLocaleString()}µm²</p>`;
    }

    infoEl.innerHTML = html;

    // Show numeric inputs for single-shape selection
    if (propsEl) {
      if (shapes.length === 1) {
        propsEl.style.display = '';
        const bb = polygonBbox(shapes[0]);
        const px = document.getElementById('prop-x') as HTMLInputElement | null;
        const py = document.getElementById('prop-y') as HTMLInputElement | null;
        const pw = document.getElementById('prop-w') as HTMLInputElement | null;
        const ph = document.getElementById('prop-h') as HTMLInputElement | null;
        // Don't overwrite inputs that the user is currently editing
        if (px && document.activeElement !== px) px.value = String(bb.minX);
        if (py && document.activeElement !== py) py.value = String(bb.minY);
        if (pw && document.activeElement !== pw) pw.value = String(bb.maxX - bb.minX);
        if (ph && document.activeElement !== ph) ph.value = String(bb.maxY - bb.minY);
      } else {
        propsEl.style.display = 'none';
      }
    }
  }

  private updateUndoButtons(): void {
    const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
    const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement | null;
    if (undoBtn) undoBtn.disabled = !this.history.canUndo();
    if (redoBtn) redoBtn.disabled = !this.history.canRedo();
  }

  destroy(): void {
    this.stopAutosave?.();
    if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
  }
}
