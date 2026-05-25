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
  DuplicateCommand, MoveCommand, ResizeCommand,
  AddLayerCommand, DeleteLayerCommand, RenameLayerCommand,
  UpdateLayerStyleCommand, MoveShapesToLayerCommand, PasteCommand,
} from '../state/commands';
import { loadPrefs, savePrefs } from '../state/autosave';
import {
  listDocs, loadDoc, saveDoc, createDoc, deleteDoc, renameDoc,
  getCurrentDocId, setCurrentDocId, getStorageEstimate,
  migrateLegacyKey, uniqueUntitledName, markDirty, startDocAutosave,
} from '../state/docStore';
import { importDxf, type ImportResult } from '../dxf/importer';
import { downloadDxf } from '../dxf/exporter';
import { downloadPdf } from '../pdf/exporter';
import { polygonArea, polygonBbox, clonePolygon, translatePolygon } from '../core/geometry';
import { resizePolygon } from '../core/transform';
import { resolveDimension } from '../core/dimension-resolve';
import { runDrc, DEFAULT_DRC_CONFIG, type DrcConfig } from '../core/drc';
import type { DrcError } from '../types';
import { UnitConverter } from '../core/format';

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
    document.getElementById('btn-file-menu')?.addEventListener('click', (e) => this.toggleFileMenu(e));
    document.getElementById('file-menu')?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.file-menu-item') as HTMLElement | null;
      if (!item) return;
      this.closeFileMenu();
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
    document.getElementById('footer-zoom')?.addEventListener('click', (e) => this.toggleZoomMenu(e));
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
        this.closeZoomMenu();
      });
    });
    document.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('#zoom-menu, #footer-zoom, #btn-zoom-in, #btn-zoom-out')) {
        this.closeZoomMenu();
      }
      if (!t.closest('#file-menu, #btn-file-menu')) {
        this.closeFileMenu();
      }
    });
    document.getElementById('footer-unit')?.addEventListener('click', () => this.toggleUnit());

    // Layer panel buttons
    document.getElementById('btn-layer-add')?.addEventListener('click', () => this.addLayer());
    document.getElementById('btn-layer-move-shapes')?.addEventListener('click', () => this.moveSelectedToActiveLayer());

    // Text panel
    const textSizeInput = document.getElementById('text-size') as HTMLInputElement | null;
    const textSpacingInput = document.getElementById('text-spacing') as HTMLInputElement | null;
    const syncTextParams = () => {
      this.textCapHeightUm = UnitConverter.parseInput(textSizeInput?.value ?? '5', this.history.state.displayUnit);
      this.textLetterSpacingUm = UnitConverter.parseInput(textSpacingInput?.value ?? '0', this.history.state.displayUnit);
      if (this.activeTool instanceof TextTool) {
        this.activeTool.setParams(this.textCapHeightUm, this.textLetterSpacingUm);
      }
    };
    textSizeInput?.addEventListener('input', syncTextParams);
    textSpacingInput?.addEventListener('input', syncTextParams);

    // Annotation panel
    const annSizeInput = document.getElementById('ann-size') as HTMLInputElement | null;
    const syncAnnParams = () => {
      this.annotationHeightUm = UnitConverter.parseInput(annSizeInput?.value ?? '5', this.history.state.displayUnit);
      if (this.activeTool instanceof AnnotationTool) {
        this.activeTool.setHeightUm(this.annotationHeightUm);
      }
    };
    annSizeInput?.addEventListener('input', syncAnnParams);

    // Rect draw panel
    const rectXInput = document.getElementById('rect-x') as HTMLInputElement | null;
    const rectYInput = document.getElementById('rect-y') as HTMLInputElement | null;
    const rectWInput = document.getElementById('rect-w') as HTMLInputElement | null;
    const rectHInput = document.getElementById('rect-h') as HTMLInputElement | null;
    const syncRectParams = () => {
      if (!(this.activeTool instanceof RectTool)) return;
      const unit = this.history.state.displayUnit;
      this.activeTool.setPlaceX(UnitConverter.parseInput(rectXInput?.value ?? '0', unit));
      this.activeTool.setPlaceY(UnitConverter.parseInput(rectYInput?.value ?? '0', unit));
      this.activeTool.setWidth(UnitConverter.parseInput(rectWInput?.value ?? '10', unit));
      this.activeTool.setHeight(UnitConverter.parseInput(rectHInput?.value ?? '10', unit));
    };
    const placeRect = () => {
      if (!(this.activeTool instanceof RectTool)) return;
      syncRectParams();
      this.activeTool.placeFromPanel(this.history.state);
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
      if (!(this.activeTool instanceof CircleTool)) return;
      const unit = this.history.state.displayUnit;
      this.activeTool.setPlaceX(UnitConverter.parseInput(circleXInput?.value ?? '0', unit));
      this.activeTool.setPlaceY(UnitConverter.parseInput(circleYInput?.value ?? '0', unit));
      this.activeTool.setDiameter(UnitConverter.parseInput(circleDInput?.value ?? '5', unit));
    };
    const placeCircle = () => {
      if (!(this.activeTool instanceof CircleTool)) return;
      syncCircleParams();
      this.activeTool.placeFromPanel(this.history.state);
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
      const r = UnitConverter.parseInput(filletRInput.value, this.history.state.displayUnit);
      if (r <= 0) return;
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
      const newX = UnitConverter.parseInput(propX.value, state.displayUnit);
      const newY = UnitConverter.parseInput(propY.value, state.displayUnit);
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
      const newW = UnitConverter.parseInput(propW.value, state.displayUnit);
      const newH = UnitConverter.parseInput(propH.value, state.displayUnit);
      if (newW < 1 || newH < 1) return;
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
      const v = UnitConverter.parseInput(drcApertureInput.value, this.history.state.displayUnit);
      if (v > 0) {
        this.drcConfig = { ...this.drcConfig, minApertureUm: v };
        savePrefs({ drcMinApertureUm: v }).catch(() => {});
        this.requestRender();
      }
    });
    drcSpacingInput?.addEventListener('change', () => {
      const v = UnitConverter.parseInput(drcSpacingInput.value, this.history.state.displayUnit);
      if (v >= 0) {
        this.drcConfig = { ...this.drcConfig, minSpacingUm: v };
        savePrefs({ drcMinSpacingUm: v }).catch(() => {});
        this.requestRender();
      }
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

  private toggleZoomMenu(e: MouseEvent): void {
    const menu = document.getElementById('zoom-menu');
    if (!menu) return;
    if (menu.hidden) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
      menu.hidden = false;
    } else {
      menu.hidden = true;
    }
  }

  private closeZoomMenu(): void {
    const menu = document.getElementById('zoom-menu');
    if (menu) menu.hidden = true;
  }

  private toggleFileMenu(e: MouseEvent): void {
    const menu = document.getElementById('file-menu');
    if (!menu) return;
    if (menu.hidden) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 4}px`;
      menu.hidden = false;
    } else {
      menu.hidden = true;
    }
  }

  private closeFileMenu(): void {
    const menu = document.getElementById('file-menu');
    if (menu) menu.hidden = true;
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

  private showMessageModal(opts: {
    title: string; message: string;
    okText?: string; cancelText?: string; danger?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = document.getElementById('message-modal') as HTMLElement;
      const titleEl = document.getElementById('message-modal-title') as HTMLElement;
      const msgEl = document.getElementById('message-modal-msg') as HTMLElement;
      const okBtn = document.getElementById('message-modal-ok') as HTMLButtonElement;
      const cancelBtn = document.getElementById('message-modal-cancel') as HTMLButtonElement;
      titleEl.textContent = opts.title;
      msgEl.textContent = opts.message;
      okBtn.textContent = opts.okText ?? 'OK';
      okBtn.style.color = opts.danger ? 'var(--danger)' : '';
      if (opts.cancelText) {
        cancelBtn.textContent = opts.cancelText;
        cancelBtn.style.display = '';
      } else {
        cancelBtn.style.display = 'none';
      }
      modal.style.display = '';
      okBtn.focus();
      const close = (result: boolean) => {
        modal.style.display = 'none';
        cancelBtn.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') close(true);
        if (e.key === 'Escape') close(opts.cancelText ? false : true);
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.addEventListener('keydown', onKey);
    });
  }

  private showDuplicateModal(): Promise<{ nx: number; ny: number; pitchX: number; pitchY: number } | null> {
    return new Promise((resolve) => {
      const modal = document.getElementById('duplicate-modal') as HTMLElement;
      const nxInput = document.getElementById('duplicate-modal-nx') as HTMLInputElement;
      const nyInput = document.getElementById('duplicate-modal-ny') as HTMLInputElement;
      const pxInput = document.getElementById('duplicate-modal-px') as HTMLInputElement;
      const pyInput = document.getElementById('duplicate-modal-py') as HTMLInputElement;
      const okBtn = document.getElementById('duplicate-modal-ok') as HTMLButtonElement;
      const cancelBtn = document.getElementById('duplicate-modal-cancel') as HTMLButtonElement;
      const unit = this.history.state.displayUnit;
      nxInput.value = String(Math.max(0, this.duplicateCountX));
      nyInput.value = String(Math.max(0, this.duplicateCountY));
      pxInput.value = UnitConverter.formatOutput(this.duplicatePitchX, unit);
      pyInput.value = UnitConverter.formatOutput(this.duplicatePitchY, unit);
      modal.style.display = '';
      nxInput.focus();
      nxInput.select();
      const close = (result: { nx: number; ny: number; pitchX: number; pitchY: number } | null) => {
        modal.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onOk = () => {
        const nx = parseInt(nxInput.value, 10);
        const ny = parseInt(nyInput.value, 10);
        const pitchX = UnitConverter.parseInput(pxInput.value, this.history.state.displayUnit);
        const pitchY = UnitConverter.parseInput(pyInput.value, this.history.state.displayUnit);
        if (isNaN(nx) || isNaN(ny) || nx < 0 || ny < 0) return;
        if (nx === 0 && ny === 0) return;
        this.duplicateCountX = nx;
        this.duplicateCountY = ny;
        this.duplicatePitchX = pitchX;
        this.duplicatePitchY = pitchY;
        close({ nx, ny, pitchX, pitchY });
      };
      const onCancel = () => close(null);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') onOk();
        if (e.key === 'Escape') close(null);
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.addEventListener('keydown', onKey);
    });
  }

  private showInputModal(opts: {
    title: string; label?: string; defaultValue?: string; okText?: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = document.getElementById('input-modal') as HTMLElement;
      const titleEl = document.getElementById('input-modal-title') as HTMLElement;
      const labelEl = document.getElementById('input-modal-label') as HTMLElement;
      const field = document.getElementById('input-modal-field') as HTMLInputElement;
      const okBtn = document.getElementById('input-modal-ok') as HTMLButtonElement;
      const cancelBtn = document.getElementById('input-modal-cancel') as HTMLButtonElement;
      titleEl.textContent = opts.title;
      labelEl.textContent = opts.label ?? '';
      labelEl.style.display = opts.label ? '' : 'none';
      field.value = opts.defaultValue ?? '';
      okBtn.textContent = opts.okText ?? 'OK';
      modal.style.display = '';
      field.focus();
      field.select();
      const close = (result: string | null) => {
        modal.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        field.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onOk = () => close(field.value.trim() || null);
      const onCancel = () => close(null);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') close(field.value.trim() || null);
        if (e.key === 'Escape') close(null);
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      field.addEventListener('keydown', onKey);
    });
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

  private async importStencilFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const raw = JSON.parse(text) as unknown;
      if (typeof raw !== 'object' || raw === null) throw new Error('Invalid JSON');
      const docs = await listDocs();
      const baseName = file.name.replace(/\.(stencil|json)$/i, '');
      const allNames = docs.map((d) => d.name);
      const used = new Set(allNames);
      let name = baseName;
      if (used.has(name)) {
        let i = 2;
        while (used.has(`${baseName} ${i}`)) i++;
        name = `${baseName} ${i}`;
      }
      // Create a new doc slot then overwrite its state with the imported stencil file
      const meta = await createDoc(name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await saveDoc(meta.id, raw as any);
      // openDoc will run migration via loadDoc
      await this.openDoc(meta.id);
    } catch (e) {
      await this.showMessageModal({ title: 'Import Stencil', message: `Import failed: ${e}` });
    }
  }

  private downloadDocAsStencil(_id: string, name: string, state: AppState): void {
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.stencil`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async showFileManager(): Promise<void> {
    const modal = document.getElementById('file-manager-modal') as HTMLElement | null;
    if (!modal) return;

    const renderList = async () => {
      const docs = await listDocs();
      docs.sort((a, b) => b.lastModified - a.lastModified);
      const listEl = document.getElementById('fm-doc-list');
      if (!listEl) return;
      listEl.innerHTML = '';
      if (docs.length === 0) {
        listEl.innerHTML = '<li class="fm-empty">No documents yet. Use File ▸ New Document to create one.</li>';
        return;
      }
      for (const doc of docs) {
        const li = document.createElement('li');
        li.className = 'fm-doc-item' + (doc.id === this.currentDocId ? ' fm-active' : '');
        const dt = new Date(doc.lastModified).toLocaleString();
        const sz = fmtBytes(doc.sizeBytes);
        li.innerHTML = `
          <div class="fm-doc-info fm-open-area" data-id="${doc.id}">
            <div class="fm-doc-name-row">
              <span class="fm-doc-name">${escHtml(doc.name)}</span>
              <button class="fm-icon-btn fm-rename-btn fm-rename" data-id="${doc.id}" title="Rename">
                <svg class="icon" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
            </div>
            <span class="fm-doc-meta">${dt} · ${sz}</span>
          </div>
          <div class="fm-doc-actions">
            <button class="fm-icon-btn fm-download" data-id="${doc.id}" title="Download">
              <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button class="fm-icon-btn fm-delete danger" data-id="${doc.id}" title="Delete">
              <svg class="icon" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>`;
        listEl.appendChild(li);
      }

      const est = await getStorageEstimate();
      const storageText = document.getElementById('fm-storage-text');
      const storageFill = document.getElementById('fm-storage-fill') as HTMLElement | null;
      if (est && storageText && storageFill) {
        const pct = est.quota > 0 ? Math.min(100, Math.round((est.usage / est.quota) * 100)) : 0;
        storageText.textContent = `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)} (${pct}%)`;
        storageFill.style.width = `${pct}%`;
        storageFill.style.background = pct > 95 ? 'var(--danger)' : pct > 80 ? 'var(--accent2)' : 'var(--accent)';
      } else if (storageText) {
        storageText.textContent = 'Storage estimate unavailable';
      }
    };

    await renderList();
    modal.style.display = '';

    const closeBtn = document.getElementById('fm-close') as HTMLButtonElement | null;
    const close = () => { modal.style.display = 'none'; };

    if (closeBtn) closeBtn.onclick = () => close();

    const listEl = document.getElementById('fm-doc-list');
    if (listEl) listEl.onclick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button[data-id]') as HTMLButtonElement | null;
      if (btn) {
        const id = btn.dataset.id!;
        if (btn.classList.contains('fm-rename')) {
          const li = btn.closest('.fm-doc-item') as HTMLElement | null;
          const nameSpan = li?.querySelector('.fm-doc-name') as HTMLElement | null;
          if (!nameSpan || nameSpan.tagName === 'INPUT') return;
          const currentName = nameSpan.textContent ?? '';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'fm-name-input';
          input.value = currentName;
          nameSpan.replaceWith(input);
          input.focus();
          input.select();
          let committed = false;
          const commit = async () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
              await renameDoc(id, newName);
              if (id === this.currentDocId) {
                this.currentDocName = newName;
                this.updateDocNameLabel();
              }
              await renderList();
            } else {
              input.replaceWith(nameSpan);
            }
          };
          input.addEventListener('keydown', (ke: KeyboardEvent) => {
            if (ke.key === 'Enter') { ke.preventDefault(); void commit(); }
            if (ke.key === 'Escape') { committed = true; input.replaceWith(nameSpan); }
          });
          input.addEventListener('blur', () => void commit());
        } else if (btn.classList.contains('fm-download')) {
          const state = await loadDoc(id);
          if (!state) return;
          const docs = await listDocs();
          const name = docs.find((d) => d.id === id)?.name ?? 'document';
          this.downloadDocAsStencil(id, name, state);
        } else if (btn.classList.contains('fm-delete')) {
          const docs = await listDocs();
          const name = docs.find((d) => d.id === id)?.name ?? 'this document';
          const ok = await this.showMessageModal({ title: 'Delete', message: `Delete "${name}"? This cannot be undone.`, okText: 'Delete', cancelText: 'Cancel', danger: true });
          if (!ok) return;
          await deleteDoc(id);
          if (id === this.currentDocId) {
            this.currentDocId = null;
            await setCurrentDocId(null);
          }
          await renderList();
          if (closeBtn) closeBtn.style.display = this.currentDocId ? '' : 'none';
        }
        return;
      }
      const area = (e.target as HTMLElement).closest('.fm-open-area[data-id]') as HTMLElement | null;
      if (area) {
        await this.openDoc(area.dataset.id!);
        close();
      }
    };
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

  private async addLayer(): Promise<void> {
    const name = await this.showInputModal({ title: 'New Layer', label: 'Layer name:' });
    if (!name) return;
    const trimmed = name.trim();
    const state = this.history.state;
    if (state.layers.some((l) => l.name === trimmed)) {
      await this.showMessageModal({ title: 'New Layer', message: `Layer "${trimmed}" already exists.` });
      return;
    }
    this.history.execute(new AddLayerCommand({
      name: trimmed, color: '#ffffff', linetype: 'CONTINUOUS',
      lineweight: -1, visible: true, locked: false, plot: true, isAperture: false,
    }));
    markDirty();
    this.requestRender();
  }

  private async renameLayer(name: string): Promise<void> {
    const newName = await this.showInputModal({ title: 'Rename Layer', label: 'New name:', defaultValue: name });
    if (!newName || newName.trim() === name) return;
    const trimmed = newName.trim();
    const state = this.history.state;
    if (state.layers.some((l) => l.name === trimmed)) {
      await this.showMessageModal({ title: 'Rename Layer', message: `Layer "${trimmed}" already exists.` });
      return;
    }
    this.history.execute(new RenameLayerCommand(name, trimmed));
    markDirty();
    this.requestRender();
  }

  private async deleteLayer(name: string): Promise<void> {
    const state = this.history.state;
    if (state.layers.length <= 1) {
      await this.showMessageModal({ title: 'Delete Layer', message: 'Cannot delete the last layer.' });
      return;
    }
    const shapeCount = state.shapes.filter((s) => s.layer === name).length;
    if (shapeCount === 0) {
      const ok = await this.showMessageModal({
        title: 'Delete Layer', message: `Delete layer "${name}"?`,
        okText: 'Delete', cancelText: 'Cancel', danger: true,
      });
      if (!ok) return;
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
    const onDel = async () => {
      const ok = await this.showMessageModal({
        title: 'Delete Layer',
        message: `Delete layer "${name}" and its ${shapeCount} shape(s)?`,
        okText: 'Delete', cancelText: 'Cancel', danger: true,
      });
      if (!ok) return;
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

  private updateFooter(state: AppState): void {
    if (this.notifyTimer !== null) return; // keep notification visible
    const el = (id: string) => document.getElementById(id);
    const unit = state.displayUnit;
    const f = (v: number) => UnitConverter.formatOutput(v, unit);

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
        if (el('footer-w')) el('footer-w')!.textContent = `dx:${f(dx)}`;
        if (el('footer-h')) el('footer-h')!.textContent = `dy:${f(dy)}`;
        if (el('footer-area')) el('footer-area')!.textContent = `d:${f(d)}`;
      } else {
        if (el('footer-w')) el('footer-w')!.textContent = 'Click p1';
        if (el('footer-h')) el('footer-h')!.textContent = '—';
        if (el('footer-area')) el('footer-area')!.textContent = 'Esc clear';
      }
    } else if (this.activeTool instanceof CutTool) {
      const ct = this.activeTool as CutTool;
      if (ct.hasP1()) {
        if (el('footer-w')) el('footer-w')!.textContent = 'Cut:';
        if (el('footer-h')) el('footer-h')!.textContent = 'Click p2';
        if (el('footer-area')) el('footer-area')!.textContent = 'Shift=angle  Esc cancel';
      } else {
        if (el('footer-w')) el('footer-w')!.textContent = 'Cut:';
        if (el('footer-h')) el('footer-h')!.textContent = 'Click p1';
        if (el('footer-area')) el('footer-area')!.textContent = 'Esc cancel';
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
        // Area is squared, so if in mm, it's mm², if in um, it's um²
        // But for mm, we need to divide by 1,000,000.
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

  private updateRightPanel(state: AppState): void {
    const unit = state.displayUnit;

    // Show/hide rect draw panel and sync values
    const rectPanel = document.getElementById('rect-panel');
    const isRectActive = this.activeTool instanceof RectTool;
    if (rectPanel) rectPanel.style.display = isRectActive ? '' : 'none';
    if (isRectActive) {
      const rt = this.activeTool as RectTool;
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
    const isCircleActive = this.activeTool instanceof CircleTool;
    if (circlePanel) circlePanel.style.display = isCircleActive ? '' : 'none';
    if (isCircleActive) {
      const ct = this.activeTool as CircleTool;
      const xIn = document.getElementById('circle-x') as HTMLInputElement | null;
      const yIn = document.getElementById('circle-y') as HTMLInputElement | null;
      const dIn = document.getElementById('circle-d') as HTMLInputElement | null;
      if (xIn && document.activeElement !== xIn) xIn.value = UnitConverter.formatOutput(ct.getPlaceX(), unit);
      if (yIn && document.activeElement !== yIn) yIn.value = UnitConverter.formatOutput(ct.getPlaceY(), unit);
      if (dIn && document.activeElement !== dIn) dIn.value = UnitConverter.formatOutput(ct.getDiameter(), unit);
    }

    // Show/hide text panel
    const textPanel = document.getElementById('text-panel');
    if (textPanel) textPanel.style.display = this.activeTool instanceof TextTool ? '' : 'none';

    // Show/hide annotation panel
    const annPanel = document.getElementById('annotation-panel');
    if (annPanel) annPanel.style.display = this.activeTool instanceof AnnotationTool ? '' : 'none';

    // Show/hide fillet panel and sync its state
    const filletPanel = document.getElementById('fillet-panel');
    const isFilletActive = this.activeTool instanceof FilletTool;
    if (filletPanel) filletPanel.style.display = isFilletActive ? '' : 'none';
    if (isFilletActive) {
      const ft = this.activeTool as FilletTool;
      const rInput = document.getElementById('fillet-r') as HTMLInputElement | null;
      if (rInput) {
        const cur = UnitConverter.parseInput(rInput.value, state.displayUnit);
        if (cur !== ft.getRadius()) rInput.value = UnitConverter.formatOutput(ft.getRadius(), state.displayUnit);
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
        // Don't overwrite inputs that the user is currently editing
        if (px && document.activeElement !== px) px.value = UnitConverter.formatOutput(bb.minX, unit);
        if (py && document.activeElement !== py) py.value = UnitConverter.formatOutput(bb.minY, unit);
        if (pw && document.activeElement !== pw) pw.value = UnitConverter.formatOutput(bb.maxX - bb.minX, unit);
        if (ph && document.activeElement !== ph) ph.value = UnitConverter.formatOutput(bb.maxY - bb.minY, unit);
      } else {
        propsEl.style.display = 'none';
      }
    }
  }

  toggleUnit(): void {
    const state = this.history.state;
    state.displayUnit = state.displayUnit === 'mm' ? 'um' : 'mm';
    this.updateUnitUI();
    markDirty();
    this.requestRender();
  }

  private updateUnitUI(): void {
    const state = this.history.state;
    const unit = state.displayUnit;
    const isMm = unit === 'mm';

    // Update footer unit button
    const unitEl = document.getElementById('footer-unit');
    if (unitEl) unitEl.textContent = unit === 'um' ? 'µm' : unit;

    // Update all unit labels in sidebar/modals
    document.querySelectorAll('.unit-label').forEach((el) => {
      el.textContent = unit === 'mm' ? 'mm' : 'µm';
    });

    const displayUnitLabel = unit === 'um' ? 'µm' : unit;
    // Update input modal labels
    document.querySelectorAll('.duplicate-modal-pitch-label').forEach((el) => { el.textContent = `Pitch (${displayUnitLabel})`; });

    // Update input attributes (step) to allow decimals in mm mode
    const inputs = document.querySelectorAll('input[type="number"]');
    inputs.forEach((input) => {
      const el = input as HTMLInputElement;
      if (el.id.includes('nx') || el.id.includes('ny')) return; // skip counts
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

    // Refresh existing values in visible inputs to match new unit
    if (this.activeTool instanceof RectTool) {
      const rt = this.activeTool;
      const rxIn = document.getElementById('rect-x') as HTMLInputElement | null;
      if (rxIn) rxIn.value = UnitConverter.formatOutput(rt.getPlaceX(), unit);
      const ryIn = document.getElementById('rect-y') as HTMLInputElement | null;
      if (ryIn) ryIn.value = UnitConverter.formatOutput(rt.getPlaceY(), unit);
      const rwIn = document.getElementById('rect-w') as HTMLInputElement | null;
      if (rwIn) rwIn.value = UnitConverter.formatOutput(rt.getWidth(), unit);
      const rhIn = document.getElementById('rect-h') as HTMLInputElement | null;
      if (rhIn) rhIn.value = UnitConverter.formatOutput(rt.getHeight(), unit);
    }
    if (this.activeTool instanceof CircleTool) {
      const ct = this.activeTool;
      const cxIn = document.getElementById('circle-x') as HTMLInputElement | null;
      if (cxIn) cxIn.value = UnitConverter.formatOutput(ct.getPlaceX(), unit);
      const cyIn = document.getElementById('circle-y') as HTMLInputElement | null;
      if (cyIn) cyIn.value = UnitConverter.formatOutput(ct.getPlaceY(), unit);
      const cdIn = document.getElementById('circle-d') as HTMLInputElement | null;
      if (cdIn) cdIn.value = UnitConverter.formatOutput(ct.getDiameter(), unit);
    }

    const textSizeIn = document.getElementById('text-size') as HTMLInputElement | null;
    if (textSizeIn) textSizeIn.value = UnitConverter.formatOutput(this.textCapHeightUm, unit);
    const textSpacingIn = document.getElementById('text-spacing') as HTMLInputElement | null;
    if (textSpacingIn) textSpacingIn.value = UnitConverter.formatOutput(this.textLetterSpacingUm, unit);
    const annSizeIn = document.getElementById('ann-size') as HTMLInputElement | null;
    if (annSizeIn) annSizeIn.value = UnitConverter.formatOutput(this.annotationHeightUm, unit);

    const filletRInput = document.getElementById('fillet-r') as HTMLInputElement | null;
    if (filletRInput) filletRInput.value = UnitConverter.formatOutput(this.filletRadius, unit);

    const drcAInput = document.getElementById('drc-min-aperture') as HTMLInputElement | null;
    if (drcAInput) drcAInput.value = UnitConverter.formatOutput(this.drcConfig.minApertureUm, unit);

    const drcSInput = document.getElementById('drc-min-spacing') as HTMLInputElement | null;
    if (drcSInput) drcSInput.value = UnitConverter.formatOutput(this.drcConfig.minSpacingUm, unit);

    const dupPxIn = document.getElementById('duplicate-modal-px') as HTMLInputElement | null;
    if (dupPxIn) dupPxIn.value = UnitConverter.formatOutput(this.duplicatePitchX, unit);
    const dupPyIn = document.getElementById('duplicate-modal-py') as HTMLInputElement | null;
    if (dupPyIn) dupPyIn.value = UnitConverter.formatOutput(this.duplicatePitchY, unit);

    // Refresh selection props if visible
    this.updateRightPanel(state);
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

// ── Module-level helpers ──────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
