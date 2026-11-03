import type { AppState } from '../types';
import type { History } from '../state/history';
import type { Command } from '../types';
import {
  AddLayerCommand, DeleteLayerCommand, RenameLayerCommand,
  UpdateLayerStyleCommand, MoveShapesToLayerCommand,
  SetSelectionCommand, CompoundCommand, layerNameTaken, canRenameLayer,
} from '../state/commands';
import { markDirty } from '../state/docStore';
import { showInputModal, showMessageModal } from './modals';
import { escHtml } from './fileManager';

export interface LayerPanelDeps {
  history: History;
  requestRender(): void;
}

let lastRenderedStateKey = '';

export function renderLayerPanel(deps: LayerPanelDeps, state: AppState): void {
  const listEl = document.getElementById('layer-list');
  if (!listEl) return;

  const key = `${state.activeLayerName}|${state.layers.map((l) => `${l.name}:${l.color}:${l.visible}:${l.isAperture}:${l.locked}`).join(';')}`;
  if (key === lastRenderedStateKey && listEl.children.length === state.layers.length) {
    return;
  }
  lastRenderedStateKey = key;

  listEl.innerHTML = '';
  for (const layer of state.layers) {
    const isActive = layer.name === state.activeLayerName;
    const row = document.createElement('div');
    row.className = 'layer-row' + (isActive ? ' is-active' : '') + (layer.isAperture ? ' is-aperture' : '');
    row.dataset.layer = layer.name;

    row.innerHTML = `
      <span class="lyr-active" title="Set active">${isActive ? '●' : '○'}</span>
      <input type="color" class="lyr-color" value="${layer.color}" title="Layer color">
      <span class="lyr-name" title="${escHtml(layer.name)}">${escHtml(layer.name)}</span>
      <button class="lyr-btn lyr-vis${isActive ? ' lyr-btn-disabled' : ''}" title="${isActive ? 'Active layer cannot be hidden' : 'Toggle visibility'}">${layer.visible ? 'V' : 'H'}</button>
      <button class="lyr-btn lyr-lock${layer.locked ? ' on' : ''}" title="${layer.locked ? 'Unlock layer' : 'Lock layer'}" aria-pressed="${layer.locked ? 'true' : 'false'}">${layer.locked ? '\u{1F512}' : '\u{1F513}'}</button>
      <button class="lyr-btn lyr-apt${layer.isAperture ? ' on' : ''}${layer.name === 'DIMENSIONS' ? ' lyr-btn-disabled' : ''}" title="${layer.name === 'DIMENSIONS' ? 'DIMENSIONS layer is never an aperture' : 'Toggle aperture (DRC + DXF export)'}">A</button>
      <button class="lyr-btn lyr-del" title="Delete layer">×</button>
    `;

    row.querySelector('.lyr-active')?.addEventListener('click', () => setActiveLayer(deps, layer.name));
    row.querySelector('.lyr-name')?.addEventListener('dblclick', () => renameLayer(deps, layer.name));
    row.querySelector('.lyr-name')?.addEventListener('click', () => setActiveLayer(deps, layer.name));

    const colorInput = row.querySelector('.lyr-color') as HTMLInputElement;
    colorInput.addEventListener('change', () => {
      deps.history.execute(new UpdateLayerStyleCommand(layer.name, { color: colorInput.value }));
      markDirty();
      deps.requestRender();
    });

    row.querySelector('.lyr-vis')?.addEventListener('click', () => {
      toggleLayerVisible(deps, layer.name);
    });
    row.querySelector('.lyr-lock')?.addEventListener('click', () => {
      toggleLayerLocked(deps, layer.name);
    });
    row.querySelector('.lyr-apt')?.addEventListener('click', () => {
      deps.history.execute(new UpdateLayerStyleCommand(layer.name, { isAperture: !layer.isAperture }));
      markDirty();
      deps.requestRender();
    });
    row.querySelector('.lyr-del')?.addEventListener('click', () => {
      void deleteLayer(deps, layer.name);
    });

    listEl.appendChild(row);
  }
}

function setActiveLayer(deps: LayerPanelDeps, name: string): void {
  const state = deps.history.state;
  const layer = state.layers.find((l) => l.name === name);
  if (!layer) return;
  if (layer.locked) return; // A locked layer cannot be the drawing target.
  state.activeLayerName = name;
  if (!layer.visible) {
    state.layers = state.layers.map((l) => l.name === name ? { ...l, visible: true } : l);
  }
  markDirty();
  deps.requestRender();
}

function toggleLayerVisible(deps: LayerPanelDeps, name: string): void {
  const state = deps.history.state;
  if (name === state.activeLayerName) return;
  const layer = state.layers.find((l) => l.name === name);
  if (!layer) return;

  const cmds: Command[] = [new UpdateLayerStyleCommand(name, { visible: !layer.visible })];

  if (layer.visible) {
    // Hiding: purge any selection entries that belong to this layer.
    const hiddenIds = new Set<string>([
      ...state.shapes.filter((s) => s.layer === name).map((s) => s.id),
      ...state.dimensions.filter((d) => d.layer === name).map((d) => d.id),
      ...state.annotations.filter((a) => a.layer === name).map((a) => a.id),
    ]);
    const newSel = state.selection.filter((s) => !hiddenIds.has(s.shapeId));
    if (newSel.length !== state.selection.length) {
      cmds.push(new SetSelectionCommand(newSel, state.selection));
    }
  }

  deps.history.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
  markDirty();
  deps.requestRender();
}

function toggleLayerLocked(deps: LayerPanelDeps, name: string): void {
  const state = deps.history.state;
  const layer = state.layers.find((l) => l.name === name);
  if (!layer) return;

  const cmds: Command[] = [new UpdateLayerStyleCommand(name, { locked: !layer.locked })];

  if (!layer.locked) {
    // Locking: purge any selection entries that belong to this layer.
    const lockedIds = new Set<string>([
      ...state.shapes.filter((s) => s.layer === name).map((s) => s.id),
      ...state.dimensions.filter((d) => d.layer === name).map((d) => d.id),
      ...state.annotations.filter((a) => a.layer === name).map((a) => a.id),
    ]);
    const newSel = state.selection.filter((s) => !lockedIds.has(s.shapeId));
    if (newSel.length !== state.selection.length) {
      cmds.push(new SetSelectionCommand(newSel, state.selection));
    }
  }

  deps.history.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
  markDirty();
  deps.requestRender();
}

export async function addLayer(deps: LayerPanelDeps): Promise<void> {
  const name = await showInputModal({ title: 'New Layer', label: 'Layer name:' });
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const state = deps.history.state;
  if (trimmed.toUpperCase() === 'DIMENSIONS') {
    await showMessageModal({ title: 'New Layer', message: '"DIMENSIONS" is a reserved layer name.' });
    return;
  }
  if (layerNameTaken(state.layers, trimmed)) {
    await showMessageModal({ title: 'New Layer', message: `Layer "${trimmed}" already exists (names are case-insensitive).` });
    return;
  }
  deps.history.execute(new AddLayerCommand({
    name: trimmed, color: '#ffffff', linetype: 'CONTINUOUS',
    lineweight: -1, visible: true, locked: false, plot: true, isAperture: false,
  }));
  markDirty();
  deps.requestRender();
}

async function renameLayer(deps: LayerPanelDeps, name: string): Promise<void> {
  if (name === 'DIMENSIONS') {
    await showMessageModal({ title: 'Rename Layer', message: 'The DIMENSIONS layer is managed automatically and cannot be renamed.' });
    return;
  }
  const newName = await showInputModal({ title: 'Rename Layer', label: 'New name:', defaultValue: name });
  if (!newName || newName.trim() === name) return;
  const trimmed = newName.trim();
  const state = deps.history.state;
  if (trimmed.toUpperCase() === 'DIMENSIONS') {
    await showMessageModal({ title: 'Rename Layer', message: '"DIMENSIONS" is a reserved layer name.' });
    return;
  }
  if (!canRenameLayer(state.layers, name, trimmed)) {
    await showMessageModal({ title: 'Rename Layer', message: `Layer "${trimmed}" already exists (names are case-insensitive).` });
    return;
  }
  deps.history.execute(new RenameLayerCommand(name, trimmed));
  markDirty();
  deps.requestRender();
}

async function deleteLayer(deps: LayerPanelDeps, name: string): Promise<void> {
  const state = deps.history.state;
  if (state.layers.length <= 1) {
    await showMessageModal({ title: 'Delete Layer', message: 'Cannot delete the last layer.' });
    return;
  }
  const shapeCount = state.shapes.filter((s) => s.layer === name).length;
  if (shapeCount === 0) {
    const ok = await showMessageModal({
      title: 'Delete Layer', message: `Delete layer "${name}"?`,
      okText: 'Delete', cancelText: 'Cancel', danger: true,
    });
    if (!ok) return;
    deps.history.execute(new DeleteLayerCommand(name, 'delete'));
    markDirty();
    deps.requestRender();
    return;
  }
  const modal = document.getElementById('layer-delete-modal') as HTMLElement;
  const msg = document.getElementById('layer-delete-msg') as HTMLElement;
  const targetSel = document.getElementById('layer-delete-target') as HTMLSelectElement;
  const btnMove = document.getElementById('layer-delete-move') as HTMLButtonElement;
  const btnDel = document.getElementById('layer-delete-destroy') as HTMLButtonElement;
  const btnCancel = document.getElementById('layer-delete-cancel') as HTMLButtonElement;

  msg.textContent = `Layer "${name}" has ${shapeCount} shape(s).`;
  targetSel.innerHTML = state.layers
    .filter((l) => l.name !== name && l.name !== 'DIMENSIONS')
    .map((l) => `<option value="${escHtml(l.name)}">${escHtml(l.name)}</option>`)
    .join('');

  modal.style.display = '';
  const close = () => { modal.style.display = 'none'; };

  const onMove = () => {
    close();
    const target = targetSel.value;
    deps.history.execute(new DeleteLayerCommand(name, 'move', target));
    markDirty();
    deps.requestRender();
  };
  const onDel = async () => {
    const ok = await showMessageModal({
      title: 'Delete Layer',
      message: `Delete layer "${name}" and its ${shapeCount} shape(s)?`,
      okText: 'Delete', cancelText: 'Cancel', danger: true,
    });
    if (!ok) return;
    close();
    deps.history.execute(new DeleteLayerCommand(name, 'delete'));
    markDirty();
    deps.requestRender();
  };

  // DIMENSIONS items cannot live on other layers, and nothing may be moved onto DIMENSIONS.
  btnMove.disabled = name === 'DIMENSIONS' || targetSel.options.length === 0;
  btnMove.onclick = onMove;
  btnDel.onclick = onDel;
  btnCancel.onclick = close;
}

export function moveSelectedToActiveLayer(deps: LayerPanelDeps): void {
  const state = deps.history.state;
  if (state.selection.length === 0) return;
  deps.history.execute(new MoveShapesToLayerCommand(state.selection, state.activeLayerName));
  markDirty();
  deps.requestRender();
}
