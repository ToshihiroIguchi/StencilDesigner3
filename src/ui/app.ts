import type { AppState, Point, ToolType } from '../types';
import { createDefaultState, canvasToWorld } from '../types';
import { History } from '../state/history';
import { CanvasRenderer } from '../canvas/renderer';
import { SelectTool } from '../tools/select';
import { RectTool } from '../tools/rect';
import { CircleTool } from '../tools/circle';
import { FilletTool } from '../tools/fillet';
import { findSnapPoint } from '../core/selection';
import { AddShapeCommand, DeleteCommand, UnionCommand, DifferenceCommand, ArrayCopyCommand, CopyCommand } from '../state/commands';
import { loadState, saveState, startAutosave, clearState, markDirty } from '../state/autosave';
import { importDxf } from '../dxf/importer';
import { downloadDxf } from '../dxf/exporter';
import { polygonArea, polygonBbox } from '../core/geometry';

type AnyTool = SelectTool | RectTool | CircleTool | FilletTool;

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
    // Restore saved state
    try {
      const saved = await loadState();
      if (saved) {
        this.history.loadState(saved);
      }
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
  }

  private getSnapPoint(worldPt: Point): Point {
    const state = this.history.state;
    if (!state.snapEnabled) return worldPt;
    return findSnapPoint(
      worldPt,
      state.shapes,
      state.gridSize,
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
    const rubberBand = this.activeTool instanceof SelectTool
      ? (this.activeTool.getRubberBand() ?? undefined)
      : undefined;
    this.renderer.render(
      state,
      this.activeTool.getDraft() ?? undefined,
      this.activeTool.getSnapPoint() ?? undefined,
      this.activeTool.showsAllVertices(),
      rubberBand,
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
    this.activeTool.onMouseMove(worldPt, canvasPt, e.shiftKey, this.history.state);

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
    this.activeTool.onMouseUp(worldPt, canvasPt, e.shiftKey, this.history.state);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const state = this.history.state;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.01, Math.min(50, state.zoom * factor));

    // Zoom around cursor position
    state.panX = mx - (mx - state.panX) * (newZoom / state.zoom);
    state.panY = my - (my - state.panY) * (newZoom / state.zoom);
    state.zoom = newZoom;

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
      if (e.key === 'f' || e.key === 'F') { this.setTool('fillet'); return; }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!inInput) this.deleteSelected();
    }
    if (e.key === 'Escape') this.activeTool.cancel();
    this.activeTool.onKeyDown(e.key, this.history.state);
  }

  setTool(tool: ToolType): void {
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
      case 'fillet': this.activeTool = new FilletTool(toolCtx); break;
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

  doUnion(): void {
    const state = this.history.state;
    const sel = state.selection;
    if (sel.length < 2) { alert('Select at least 2 shapes for Union'); return; }
    this.history.execute(new UnionCommand(sel));
    markDirty();
    this.requestRender();
  }

  doDifference(): void {
    const state = this.history.state;
    const sel = state.selection;
    if (sel.length !== 2) { alert('Select exactly 2 shapes for Difference (first = subject, second = cutter)'); return; }
    this.history.execute(new DifferenceCommand(sel[0], sel[1]));
    markDirty();
    this.requestRender();
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
      const polygons = await importDxf(text);
      for (const poly of polygons) {
        this.history.execute(new AddShapeCommand(poly));
      }
      markDirty();
      this.requestRender();
    } catch (e) {
      alert(`DXF import failed: ${e}`);
    }
  }

  exportDxf(): void {
    const state = this.history.state;
    downloadDxf(state.shapes);
  }

  async hardReset(): Promise<void> {
    if (!confirm('Clear all shapes and history?')) return;
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

  private updateFooter(state: AppState): void {
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

    const el = (id: string) => document.getElementById(id);
    const f = (v: number) => v.toLocaleString();
    if (el('footer-w')) el('footer-w')!.textContent = f(w);
    if (el('footer-h')) el('footer-h')!.textContent = f(h);
    if (el('footer-area')) el('footer-area')!.textContent = f(Math.round(a));
    if (el('footer-grid')) el('footer-grid')!.textContent = `${state.gridSize}µm`;
    if (el('footer-snap')) el('footer-snap')!.textContent = state.snapEnabled ? 'ON' : 'OFF';
    if (el('footer-zoom')) el('footer-zoom')!.textContent = `${(state.zoom * 100).toFixed(0)}%`;
  }

  private updateRightPanel(state: AppState): void {
    const sel = state.selection;
    const infoEl = document.getElementById('selection-info');
    if (!infoEl) return;

    if (sel.length === 0) {
      infoEl.innerHTML = '<p class="muted">No selection</p>';
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
