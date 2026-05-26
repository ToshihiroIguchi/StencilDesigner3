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
import { ArrowTool } from '../tools/arrow';
import { TextTool } from '../tools/text';
import { AnnotationTool } from '../tools/annotation';
import { CutTool } from '../tools/cut';
import { hitTest, hitTestAnnotation } from '../core/selection';
import { findSnap, type SnapResult } from '../core/snap';
import {
  AddShapeCommand, DeleteCommand, UnionCommand, DifferenceCommand,
  DuplicateCommand, MoveCommand,
  AddLayerCommand, PasteCommand,
} from '../state/commands';
import { loadPrefs } from '../state/autosave';
import {
  listDocs, loadDoc, saveDoc, createDoc, deleteDoc, renameDoc,
  getCurrentDocId, setCurrentDocId,
  migrateLegacyKey, uniqueUntitledName, markDirty, startDocAutosave,
} from '../state/docStore';
import { importDxf, type ImportResult } from '../dxf/importer';
import { downloadDxf } from '../dxf/exporter';
import { downloadPdf } from '../pdf/exporter';
import { polygonBbox, clonePolygon, translatePolygon } from '../core/geometry';
import { resolveDimension } from '../core/dimension-resolve';
import { runDrc, DEFAULT_DRC_CONFIG, type DrcConfig } from '../core/drc';
import type { DrcError } from '../types';
import { UnitConverter } from '../core/format';
import {
  showMessageModal as showMessageModalImpl,
  showDuplicateModal as showDuplicateModalImpl,
  type MessageModalOptions,
} from './modals';
import {
  showFileManager as showFileManagerImpl,
  importStencilFile as importStencilFileImpl,
} from './fileManager';
import {
  renderLayerPanel as renderLayerPanelImpl,
  addLayer as addLayerImpl,
  moveSelectedToActiveLayer as moveSelectedToActiveLayerImpl,
  type LayerPanelDeps,
} from './layerPanel';
import {
  updateFooter as updateFooterImpl,
  updateRightPanel as updateRightPanelImpl,
  updateUnitUI as updateUnitUIImpl,
} from './rightPanel';
import { toggleZoomMenu, closeZoomMenu, toggleFileMenu, closeFileMenu } from './menus';
import { bindPanelInputs } from './panelBindings';

type AnyTool = SelectTool | RectTool | CircleTool | FilletTool | PolygonTool | MeasureTool | DimensionTool | CenterlineTool | ArrowTool | TextTool | AnnotationTool | CutTool;

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
  private clipboard: import('../types').Polygon[] = [];
  private duplicateCountX = 1;  // last-used additional copy count X
  private duplicateCountY = 0;  // last-used additional copy count Y
  private duplicatePitchX = 2000;   // µm — last-used Duplicate pitch X
  private duplicatePitchY = 2000;   // µm — last-used Duplicate pitch Y
  private drcConfig: DrcConfig = { ...DEFAULT_DRC_CONFIG };
  private drcErrors: DrcError[] = [];
  private diffStep: 0 | 1 | 2 = 0;
  private diffBaseId: string | null = null;
  private currentDocId: string | null = null;
  private textCapHeightUm = 5000;
  private textLetterSpacingUm = 0;
  private annotationHeightUm = 3000;
  private currentDocName = '';
  private storageBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private dragCounter = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.history = new History(createDefaultState());
    this.renderer = new CanvasRenderer(canvas, this.isDark);

    const toolCtx = {
      history: this.history,
      getSnap: (worldPt: Point) => this.getSnap(worldPt),
      requestRender: () => this.requestRender(),
      notify: (msg: string) => this.showNotify(msg),
    };
    this.activeTool = new SelectTool(toolCtx);
  }

  async init(): Promise<void> {
    await migrateLegacyKey();

    try {
      const prefs = await loadPrefs();
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

    this.updateUnitUI();
    this.renderer.resize();
    this.setupEventListeners();

    this.stopAutosave = startDocAutosave(
      () => this.currentDocId,
      () => this.history.state,
      (msg) => this.showStorageFullBanner(msg)
    );

    this.requestRender();

    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.requestRender();
    });

    window.addEventListener('beforeunload', () => {
      if (this.currentDocId) void saveDoc(this.currentDocId, this.history.state);
    });

    // Restore last opened doc, or auto-create an initial Untitled
    try {
      const lastId = await getCurrentDocId();
      const docs = await listDocs();
      if (lastId && docs.some((d) => d.id === lastId)) {
        await this.openDoc(lastId);
      } else if (docs.length > 0) {
        await this.openDoc(docs[0].id);
      } else {
        await this.newDoc();
      }
    } catch {
      await this.newDoc();
    }
  }

  private getSnap(worldPt: Point): SnapResult {
    const state = this.history.state;
    if (!state.snapEnabled) return { point: worldPt, kind: 'grid' };
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const interactiveShapes = state.shapes.filter((s) => {
      const l = layerMap.get(s.layer);
      return l && l.visible;
    });
    const subGs = state.gridSize / 5;
    const effectiveGrid = subGs * state.zoom >= 8 ? subGs : state.gridSize;
    return findSnap(
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
      this.activeTool.getSnap() ?? undefined,
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
            : this.activeTool instanceof ArrowTool
              ? (this.activeTool.getRendererExtras().dimDraft ?? undefined)
              : undefined,
        selectedDimIds: new Set(state.selection.filter((s) => s.type === 'dimension').map((s) => s.shapeId)),
        selectedAnnotationIds: new Set(state.selection.filter((s) => s.type === 'annotation').map((s) => s.shapeId)),
        annotationPreviewPt: this.activeTool instanceof AnnotationTool
          ? (this.activeTool.getPreviewPt() ?? undefined) : undefined,
        textPreviewPolys: this.activeTool instanceof TextTool
          ? (this.activeTool.getTextPreviewPolys() ?? undefined)
          : undefined,
        drawHud: (this.activeTool instanceof RectTool || this.activeTool instanceof CircleTool)
          ? (this.activeTool.getDrawHud(state.displayUnit) ?? undefined)
          : undefined,
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
    document.getElementById('btn-copy-btn')?.addEventListener('click', () => this.doDuplicate());
    document.getElementById('btn-file-menu')?.addEventListener('click', (e) => toggleFileMenu(e));
    document.getElementById('file-menu')?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.file-menu-item') as HTMLElement | null;
      if (!item) return;
      closeFileMenu();
      switch (item.dataset.action) {
        case 'new-doc':        void this.newDoc(); break;
        case 'open-doc':       void this.showFileManager(); break;
        case 'open-from-disk': document.getElementById('stencil-file-input')?.click(); break;
        case 'import-dxf':     void this.importDxf(); break;
        case 'export-dxf':     this.exportDxf(); break;
        case 'export-pdf':     void this.exportPdf(); break;
      }
    });
    document.getElementById('btn-theme')?.addEventListener('click', () => this.toggleTheme());
    document.getElementById('btn-clear')?.addEventListener('click', () => { void this.clearCurrentDoc(); });
    document.getElementById('btn-snap')?.addEventListener('click', () => this.toggleSnap());
    document.getElementById('btn-fit')?.addEventListener('click', () => this.fitToContent());
    document.getElementById('btn-help')?.addEventListener('click', () => this.toggleHelpModal());
    document.getElementById('shortcut-close')?.addEventListener('click', () => this.closeHelpModal());
    document.getElementById('footer-zoom')?.addEventListener('click', (e) => toggleZoomMenu(e));
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this.zoomStep(1));
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this.zoomStep(-1));
    document.querySelectorAll('.zoom-menu-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const val = (e.currentTarget as HTMLElement).dataset.zoom;
        if (val === 'fit') {
          this.fitToContent();
        } else {
          const cx = this.canvas.clientWidth / 2;
          const cy = this.canvas.clientHeight / 2;
          this.setZoom(parseFloat(val!), cx, cy);
          this.requestRender();
        }
        closeZoomMenu();
      });
    });
    document.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('#zoom-menu, #footer-zoom, #btn-zoom-in, #btn-zoom-out')) {
        closeZoomMenu();
      }
      if (!t.closest('#file-menu, #btn-file-menu')) {
        closeFileMenu();
      }
    });
    document.getElementById('footer-unit')?.addEventListener('click', () => this.toggleUnit());

    // Layer panel buttons
    document.getElementById('btn-layer-add')?.addEventListener('click', () => this.addLayer());
    document.getElementById('btn-layer-move-shapes')?.addEventListener('click', () => this.moveSelectedToActiveLayer());

    bindPanelInputs({
      history: this.history,
      getActiveTool: () => this.activeTool,
      requestRender: () => this.requestRender(),
      setTextCapHeight: (um) => { this.textCapHeightUm = um; },
      setTextLetterSpacing: (um) => { this.textLetterSpacingUm = um; },
      setAnnotationHeight: (um) => { this.annotationHeightUm = um; },
      setFilletRadius: (um) => { this.filletRadius = um; },
      getDrcConfig: () => this.drcConfig,
      setDrcConfig: (cfg) => { this.drcConfig = cfg; },
    });

    // DXF file input
    const fileInput = document.getElementById('dxf-file-input') as HTMLInputElement | null;
    fileInput?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadDxfFile(file);
    });

    // Stencil file input (File > Open from Disk…)
    const stencilFileInput = document.getElementById('stencil-file-input') as HTMLInputElement | null;
    stencilFileInput?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        void this.importStencilFile(file).then(() => { stencilFileInput.value = ''; });
      }
    });

    // Drag-and-drop file import
    const dropOverlay = document.getElementById('drop-overlay') as HTMLElement | null;
    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (this.isAnyModalOpen()) return;
      this.dragCounter++;
      if (dropOverlay) dropOverlay.hidden = false;
    });
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('dragleave', () => {
      this.dragCounter--;
      if (this.dragCounter <= 0) {
        this.dragCounter = 0;
        if (dropOverlay) dropOverlay.hidden = true;
      }
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dragCounter = 0;
      if (dropOverlay) dropOverlay.hidden = true;
      if (this.isAnyModalOpen()) return;
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'dxf') {
        this.loadDxfFile(file);
      } else if (ext === 'stencil' || ext === 'json') {
        void this.importStencilFile(file);
      } else {
        void this.showMessageModal({ title: 'Import', message: `Unsupported file type: .${ext}\nDrop a .dxf or .stencil file.` });
      }
    });
  }

  private isAnyModalOpen(): boolean {
    return [...document.querySelectorAll<HTMLElement>('.modal-overlay')]
      .some((el) => el.style.display !== 'none');
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
    if (cursorX) cursorX.textContent = UnitConverter.formatOutput(worldPt.x, this.history.state.displayUnit);
    if (cursorY) cursorY.textContent = UnitConverter.formatOutput(worldPt.y, this.history.state.displayUnit);
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

  private onDblClick(e: MouseEvent): void {
    if (this.activeTool instanceof PolygonTool) {
      // Double-click fires mousedown twice before dblclick; the second mousedown already
      // added a duplicate vertex — remove it, then commit with what we have.
      (this.activeTool as PolygonTool).commitFromDblClick(this.history.state);
      return;
    }

    // Double-click on annotation → switch to annotation tool and open editor
    if (this.activeTool instanceof SelectTool) {
      const { canvasPt } = this.getCanvasPt(e);
      const state = this.history.state;
      const layerMap = new Map(state.layers.map((l) => [l.name, l]));
      const visibleAnns = state.annotations.filter((a) => {
        const l = layerMap.get(a.layer);
        return l && l.visible && !l.locked;
      });
      const hit = hitTestAnnotation(canvasPt.x, canvasPt.y, visibleAnns, state);
      if (hit) {
        const ann = state.annotations.find((a) => a.id === hit.id);
        if (ann) {
          this.setTool('annotation');
          const tool = this.activeTool;
          if (tool instanceof AnnotationTool) tool.startEdit(ann, canvasPt);
        }
      }
    }
  }

  private setZoom(newZoom: number, anchorCanvasX?: number, anchorCanvasY?: number): void {
    const state = this.history.state;
    const z = Math.max(0.001, Math.min(50, newZoom));
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
    const target = e.target as HTMLElement;
    const inInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const editingText = (this.activeTool instanceof TextTool && this.activeTool.isEditing())
      || (this.activeTool instanceof AnnotationTool && this.activeTool.isEditing());

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Shift+Z must be checked before plain Ctrl+Z
      if (e.key === 'z' && e.shiftKey) {
        if (editingText) return;
        e.preventDefault(); this.redo(); return;
      }
      if (e.key === 'z') {
        if (editingText) return;
        e.preventDefault(); this.undo(); return;
      }
      if (e.key === 'y') {
        if (editingText) return;
        e.preventDefault(); this.redo(); return;
      }
      if (e.key === 's') { e.preventDefault(); if (this.currentDocId) void saveDoc(this.currentDocId, this.history.state); return; }
      // Clipboard / selection shortcuts — skip when focus is in an input or text tool is editing
      if (!inInput && !editingText) {
        if (e.key === 'a') { e.preventDefault(); this.selectAll(); return; }
        if (e.key === 'c') { e.preventDefault(); this.copySelectedToClipboard(); return; }
        if (e.key === 'x') { e.preventDefault(); this.cutSelected(); return; }
        if (e.key === 'v') { e.preventDefault(); this.pasteFromClipboard(); return; }
        if (e.key === 'd') { e.preventDefault(); this.duplicateSelected(); return; }
      }
    }
    if (!inInput && !e.ctrlKey && !e.metaKey) {
      if (e.key === '?' || e.key === 'h' || e.key === 'H') { e.preventDefault(); this.toggleHelpModal(); return; }
      if (e.key === 'v' || e.key === 'V') { this.setTool('select'); return; }
      if (e.key === 'r' || e.key === 'R') { this.setTool('rect'); return; }
      if (e.key === 'c' || e.key === 'C') { this.setTool('circle'); return; }
      if (e.key === 'p' || e.key === 'P') { this.setTool('polygon'); return; }
      if (e.key === 'f' || e.key === 'F') { this.setTool('fillet'); return; }
      if (e.key === 'k' || e.key === 'K') { this.setTool('cut'); return; }
      if (e.key === 'm' || e.key === 'M') { this.setTool('measure'); return; }
      if (e.key === 'd' || e.key === 'D') { this.setTool('dimension'); return; }
      if (e.key === 'l' || e.key === 'L') { this.setTool('centerline'); return; }
      if (e.key === 'a' || e.key === 'A') { this.setTool('arrow'); return; }
      if (e.key === 't' || e.key === 'T') { this.setTool('text'); return; }
      if (e.key === 'n' || e.key === 'N') { this.setTool('annotation'); return; }
      if (e.key === 'Home') { e.preventDefault(); this.fitToContent(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomStep(1); return; }
      if (e.key === '-') { e.preventDefault(); this.zoomStep(-1); return; }
      if (e.key === '0') { e.preventDefault(); this.resetZoom(); return; }
      // Arrow key nudge — active only in select tool with a selection
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const state = this.history.state;
        if (state.selection.length > 0 && state.activeTool === 'select') {
          e.preventDefault();
          const step = state.gridSize * (e.shiftKey ? 10 : 1);
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          this.history.execute(new MoveCommand(state.selection, dx, dy));
          markDirty();
          this.requestRender();
          return;
        }
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // PolygonTool in progress consumes Backspace to pop the last vertex
      if (!inInput && this.activeTool instanceof PolygonTool && this.activeTool.isDrawing()) {
        // handled by onKeyDown below
      } else if (!inInput) {
        this.deleteSelected();
      }
    }
    if (e.key === 'Escape') {
      this.cancelDiffMode();
      this.closeHelpModal();
      this.activeTool.cancel();
    }
    this.activeTool.onKeyDown(e.key, this.history.state);
  }

  setTool(tool: ToolType): void {
    this.cancelDiffMode();
    this.activeTool.cancel();
    const toolCtx = {
      history: this.history,
      getSnap: (worldPt: Point) => this.getSnap(worldPt),
      requestRender: () => this.requestRender(),
      notify: (msg: string) => this.showNotify(msg),
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
      case 'cut': this.activeTool = new CutTool(toolCtx); break;
      case 'measure': this.activeTool = new MeasureTool(toolCtx); break;
      case 'dimension': this.activeTool = new DimensionTool(toolCtx); break;
      case 'centerline': this.activeTool = new CenterlineTool(toolCtx); break;
      case 'arrow': this.activeTool = new ArrowTool(toolCtx); break;
      case 'text': {
        const tt = new TextTool(toolCtx);
        tt.setParams(this.textCapHeightUm, this.textLetterSpacingUm);
        this.activeTool = tt;
        break;
      }
      case 'annotation': {
        this.activeTool = new AnnotationTool(toolCtx, this.annotationHeightUm);
        break;
      }
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
    const state = this.history.state;
    if (state.selection.length === 0) return;
    this.history.execute(new DeleteCommand(state.selection));
    markDirty();
    this.requestRender();
  }

  async doUnion(): Promise<void> {
    const state = this.history.state;
    const sel = state.selection;
    if (sel.length < 2) {
      await this.showMessageModal({ title: 'Union', message: 'Select at least 2 shapes for Union.' });
      return;
    }
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

  selectAll(): void {
    const state = this.history.state;
    const layerMap = new Map(state.layers.map((l) => [l.name, l]));
    const selectable = state.shapes.filter((s) => {
      const l = layerMap.get(s.layer);
      return l && l.visible && !l.locked;
    });
    if (selectable.length === 0) return;
    state.selection = selectable.map((s) => ({
      type: 'polygon' as const, shapeId: s.id, index: -1, holeIndex: -1,
    }));
    this.requestRender();
  }

  duplicateSelected(): void {
    const state = this.history.state;
    if (state.selection.length === 0) return;
    this.history.execute(new DuplicateCommand(state.selection, 1, 0, this.duplicatePitchX, this.duplicatePitchY));
    markDirty();
    this.requestRender();
  }

  copySelectedToClipboard(): void {
    const state = this.history.state;
    const ids = new Set(
      state.selection.filter((s) => s.type === 'polygon').map((s) => s.shapeId),
    );
    if (ids.size === 0) return;
    this.clipboard = state.shapes
      .filter((s) => ids.has(s.id))
      .map((s) => clonePolygon(s));
  }

  pasteFromClipboard(): void {
    if (this.clipboard.length === 0) return;
    const pasted = this.clipboard.map((p) => translatePolygon(p, this.duplicatePitchX, this.duplicatePitchY));
    this.clipboard = pasted.map((p) => clonePolygon(p));
    this.history.execute(new PasteCommand(pasted));
    markDirty();
    this.requestRender();
  }

  cutSelected(): void {
    this.copySelectedToClipboard();
    this.deleteSelected();
  }

  async doDuplicate(): Promise<void> {
    const state = this.history.state;
    if (state.selection.length === 0) return;
    const result = await this.showDuplicateModal();
    if (result === null) return;
    this.history.execute(new DuplicateCommand(state.selection, result.nx, result.ny, result.pitchX, result.pitchY));
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
      await this.showMessageModal({ title: 'Import DXF', message: `DXF import failed: ${e}` });
    }
  }

  private async showImportDialog(result: ImportResult): Promise<void> {
    const existingNames = new Set(this.history.state.layers.map((l) => l.name));
    const newLayers = result.layers.filter((l) => !existingNames.has(l.name));

    // No new layers — import shapes directly without showing a dialog
    if (newLayers.length === 0) {
      for (const poly of result.polygons) {
        this.history.execute(new AddShapeCommand(poly));
      }
      markDirty();
      this.requestRender();
      return;
    }

    const modal = document.getElementById('dxf-import-modal') as HTMLElement;
    const layersDiv = document.getElementById('dxf-import-layers') as HTMLElement;
    const okBtn = document.getElementById('dxf-import-ok') as HTMLButtonElement;
    const cancelBtn = document.getElementById('dxf-import-cancel') as HTMLButtonElement;

    // Build layer list showing only new layers, all pre-checked
    layersDiv.innerHTML = '';
    for (const layer of newLayers) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
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
    state.panX = Math.round(this.canvas.clientWidth / 2 - wx * state.zoom);
    state.panY = Math.round(this.canvas.clientHeight / 2 - wy * state.zoom);
    this.requestRender();
  }

  private setDefaultEmptyView(): void {
    const RULER = 24;
    const viewW = this.canvas.clientWidth - RULER;
    const viewH = this.canvas.clientHeight - RULER;
    const TARGET_UM_X = 100_000; // 100 mm
    const TARGET_UM_Y = 70_000;  // 70 mm
    const zoomX = viewW / TARGET_UM_X;
    const zoomY = viewH / TARGET_UM_Y;
    this.setZoom(Math.min(zoomX, zoomY));
    const state = this.history.state;
    state.panX = Math.round(RULER + 20);
    state.panY = Math.round(RULER + viewH / 2);
  }

  fitToContent(): void {
    const state = this.history.state;
    const RULER = 24;
    const viewW = this.canvas.clientWidth - RULER;
    const viewH = this.canvas.clientHeight - RULER;

    if (state.shapes.length === 0 && state.dimensions.length === 0 && state.annotations.length === 0) {
      this.setDefaultEmptyView();
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
    for (const a of state.annotations) {
      expandBbox(a.origin.x, a.origin.y);
    }

    const contentW = maxX - minX || 1;
    const contentH = maxY - minY || 1;
    const z = Math.min(viewW / (contentW * 1.2), viewH / (contentH * 1.2), 50);
    this.setZoom(z);
    state.panX = Math.round(RULER + viewW / 2 - ((minX + maxX) / 2) * z);
    state.panY = Math.round(RULER + viewH / 2 - ((minY + maxY) / 2) * z);
    this.requestRender();
  }

  private zoomStep(dir: 1 | -1): void {
    const state = this.history.state;
    const cx = this.canvas.clientWidth / 2;
    const cy = this.canvas.clientHeight / 2;
    this.setZoom(state.zoom * (dir > 0 ? 1.25 : 1 / 1.25), cx, cy);
    this.requestRender();
  }

  private resetZoom(): void {
    const state = this.history.state;
    if (state.shapes.length === 0 && state.dimensions.length === 0 && state.annotations.length === 0) {
      this.setDefaultEmptyView();
    } else {
      this.fitToContent();
    }
    this.requestRender();
  }

  exportDxf(): void {
    const state = this.history.state;
    const hasAnnotations = state.annotations.some((a) => a.text.trim().length > 0);
    if (state.shapes.length === 0 && !hasAnnotations) {
      void this.showMessageModal({ title: 'Export', message: 'Nothing to export.' });
      return;
    }
    if (state.shapes.length > 0) {
      const apertureNames = new Set(state.layers.filter((l) => l.isAperture).map((l) => l.name));
      if (!state.shapes.some((s) => apertureNames.has(s.layer)) && !hasAnnotations) {
        void this.showMessageModal({ title: 'Export', message: 'No shapes to export. Mark at least one layer as aperture using the "A" button in the Layers panel.' });
        return;
      }
    }
    downloadDxf(state.shapes, state.layers, state.annotations);
  }

  async exportPdf(): Promise<void> {
    const state = this.history.state;
    const hasAnnotations = state.annotations.some((a) => a.text.trim().length > 0);
    if (state.shapes.length === 0 && state.dimensions.length === 0 && !hasAnnotations) {
      await this.showMessageModal({ title: 'Export PDF', message: 'Nothing to export.' });
      return;
    }
    const ok = await downloadPdf(state, this.currentDocName);
    if (!ok) {
      await this.showMessageModal({ title: 'Export PDF', message: 'No visible content to export. Make at least one layer visible.' });
    }
  }

  private showMessageModal(opts: MessageModalOptions): Promise<boolean> {
    return showMessageModalImpl(opts);
  }

  private async showDuplicateModal(): Promise<{ nx: number; ny: number; pitchX: number; pitchY: number } | null> {
    const result = await showDuplicateModalImpl({
      countX: this.duplicateCountX,
      countY: this.duplicateCountY,
      pitchX: this.duplicatePitchX,
      pitchY: this.duplicatePitchY,
      unit: this.history.state.displayUnit,
    });
    if (result) {
      this.duplicateCountX = result.nx;
      this.duplicateCountY = result.ny;
      this.duplicatePitchX = result.pitchX;
      this.duplicatePitchY = result.pitchY;
    }
    return result;
  }

  // ─── Document management ────────────────────────────────────────────────────

  async openDoc(id: string): Promise<void> {
    const state = await loadDoc(id);
    if (!state) return;
    this.cancelDiffMode();
    this.history.loadState(state);
    const s = this.history.state;
    s.gridSize = computeNiceGridSize(s.zoom);
    if (s.shapes.length === 0 && s.dimensions.length === 0 && s.annotations.length === 0) {
      this.setDefaultEmptyView();
    }
    this.currentDocId = id;
    const docs = await listDocs();
    const meta = docs.find((d) => d.id === id);
    this.currentDocName = meta?.name ?? '';
    await setCurrentDocId(id);
    this.updateDocNameLabel();
    this.updateUnitUI();
    this.requestRender();
  }

  async newDoc(): Promise<void> {
    const docs = await listDocs();
    const name = uniqueUntitledName(docs);
    const meta = await createDoc(name);
    await this.openDoc(meta.id);
  }

  private updateDocNameLabel(): void {
    const el = document.getElementById('doc-name-label');
    if (!el) return;
    el.textContent = this.currentDocName || 'Untitled';
    el.title = 'Click to rename';
    el.onclick = () => this.startInlineRename(el);
  }

  private startInlineRename(el: HTMLElement): void {
    if (!this.currentDocId) return;
    const current = this.currentDocName || 'Untitled';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'doc-name-input';
    el.replaceWith(input);
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      const id = this.currentDocId;
      const span = document.createElement('span');
      span.id = 'doc-name-label';
      input.replaceWith(span);
      if (newName && newName !== current && id) {
        await renameDoc(id, newName);
        this.currentDocName = newName;
      }
      this.updateDocNameLabel();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  }

  private showStorageFullBanner(msg: string): void {
    const footer = document.getElementById('footer');
    if (!footer) return;
    let banner = document.getElementById('storage-full-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'storage-full-banner';
      banner.className = 'storage-banner';
      footer.prepend(banner);
    }
    banner.textContent = '⚠ ' + msg;
    if (this.storageBannerTimer !== null) clearTimeout(this.storageBannerTimer);
    this.storageBannerTimer = setTimeout(() => {
      banner?.remove();
      this.storageBannerTimer = null;
    }, 10000);
  }

  private importStencilFile(file: File): Promise<void> {
    return importStencilFileImpl(file, (id) => this.openDoc(id));
  }

  private showFileManager(): Promise<void> {
    return showFileManagerImpl({
      getCurrentDocId: () => this.currentDocId,
      setCurrentDocId: async (id) => { this.currentDocId = id; await setCurrentDocId(id); },
      openDoc: (id) => this.openDoc(id),
      setCurrentDocName: (name) => { this.currentDocName = name; },
      updateDocNameLabel: () => this.updateDocNameLabel(),
    });
  }

  /** For E2E tests: delete all docs and create a fresh Untitled. */
  async resetForTests(): Promise<void> {
    this.cancelDiffMode();
    const docs = await listDocs();
    await Promise.all(docs.map((d) => deleteDoc(d.id)));
    await setCurrentDocId(null);
    await this.newDoc();
  }

  async clearCurrentDoc(): Promise<void> {
    const ok = await this.showMessageModal({ title: 'Clear All', message: 'Remove all shapes from this document?', okText: 'Clear', cancelText: 'Cancel', danger: true });
    if (!ok) return;
    this.cancelDiffMode();
    const prev = this.history.state;
    this.history.loadState(createDefaultState());
    // Preserve display unit and snap preference from the current session
    this.history.state.displayUnit = prev.displayUnit;
    this.history.state.snapEnabled = prev.snapEnabled;
    markDirty();
    this.requestRender();
  }

  toggleTheme(): void {
    this.isDark = !this.isDark;
    this.renderer.setTheme(this.isDark);
    document.body.classList.toggle('light', !this.isDark);
    this.updateThemeButton();
    this.requestRender();
  }

  private updateThemeButton(): void {
    const icon = document.getElementById('theme-icon');
    const label = document.getElementById('theme-label');
    const MOON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    const SUN = '<circle cx="12" cy="12" r="5"/>' +
      '<line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>' +
      '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>' +
      '<line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>' +
      '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    if (icon) icon.innerHTML = this.isDark ? MOON : SUN;
    if (label) label.textContent = this.isDark ? 'Dark' : 'Light';
  }

  toggleSnap(): void {
    const state = this.history.state;
    state.snapEnabled = !state.snapEnabled;
    const btn = document.getElementById('btn-snap');
    if (btn) btn.classList.toggle('active', state.snapEnabled);
    this.requestRender();
  }

  // ─── Layer panel ────────────────────────────────────────────────────────────

  private get layerPanelDeps(): LayerPanelDeps {
    return { history: this.history, requestRender: () => this.requestRender() };
  }

  private renderLayerPanel(state: AppState): void {
    renderLayerPanelImpl(this.layerPanelDeps, state);
  }

  private addLayer(): Promise<void> {
    return addLayerImpl(this.layerPanelDeps);
  }

  private moveSelectedToActiveLayer(): void {
    moveSelectedToActiveLayerImpl(this.layerPanelDeps);
  }

  // ─── Notification ────────────────────────────────────────────────────────────

  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  private showNotify(msg: string): void {
    const w = document.getElementById('footer-w');
    const h = document.getElementById('footer-h');
    const area = document.getElementById('footer-area');
    if (w) w.textContent = msg;
    if (h) h.textContent = '';
    if (area) area.textContent = '';
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.requestRender();
    }, 3000);
  }

  // ─── Right panel ────────────────────────────────────────────────────────────

  private get panelDeps() {
    return {
      getActiveTool: () => this.activeTool,
      getDrcErrors: () => this.drcErrors,
      getDiffStep: () => this.diffStep,
      isNotifying: () => this.notifyTimer !== null,
      panToWorld: (x: number, y: number) => this.panToWorld(x, y),
    };
  }

  private updateFooter(state: AppState): void {
    updateFooterImpl(state, this.panelDeps);
  }

  private updateRightPanel(state: AppState): void {
    updateRightPanelImpl(state, {
      ...this.panelDeps,
      renderLayerPanel: (s) => this.renderLayerPanel(s),
    });
  }

  toggleUnit(): void {
    const state = this.history.state;
    state.displayUnit = state.displayUnit === 'mm' ? 'um' : 'mm';
    this.updateUnitUI();
    markDirty();
    this.requestRender();
  }

  private updateUnitUI(): void {
    updateUnitUIImpl(this.history.state, {
      getActiveTool: () => this.activeTool,
      textCapHeightUm: this.textCapHeightUm,
      textLetterSpacingUm: this.textLetterSpacingUm,
      annotationHeightUm: this.annotationHeightUm,
      filletRadius: this.filletRadius,
      drcMinApertureUm: this.drcConfig.minApertureUm,
      drcMinSpacingUm: this.drcConfig.minSpacingUm,
      duplicatePitchX: this.duplicatePitchX,
      duplicatePitchY: this.duplicatePitchY,
      refreshRightPanel: () => this.updateRightPanel(this.history.state),
    });
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

  toggleHelpModal(): void {
    const modal = document.getElementById('shortcut-modal');
    if (!modal) return;
    if (modal.style.display === 'none') {
      modal.style.display = 'flex';
    } else {
      modal.style.display = 'none';
    }
  }

  closeHelpModal(): void {
    const modal = document.getElementById('shortcut-modal');
    if (modal) modal.style.display = 'none';
  }
}

