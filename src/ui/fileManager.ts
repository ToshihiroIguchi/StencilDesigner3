import type { AppState } from '../types';
import {
  listDocs, loadDoc, saveDoc, createDoc, deleteDoc, renameDoc, getStorageEstimate,
} from '../state/docStore';
import { showMessageModal } from './modals';

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function downloadDocAsStencil(name: string, state: AppState): void {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.stencil`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface FileManagerDeps {
  getCurrentDocId(): string | null;
  setCurrentDocId(id: string | null): Promise<void>;
  openDoc(id: string): Promise<void>;
  setCurrentDocName(name: string): void;
  updateDocNameLabel(): void;
}

export async function showFileManager(deps: FileManagerDeps): Promise<void> {
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
      li.className = 'fm-doc-item' + (doc.id === deps.getCurrentDocId() ? ' fm-active' : '');
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
            if (id === deps.getCurrentDocId()) {
              deps.setCurrentDocName(newName);
              deps.updateDocNameLabel();
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
        downloadDocAsStencil(name, state);
      } else if (btn.classList.contains('fm-delete')) {
        const docs = await listDocs();
        const name = docs.find((d) => d.id === id)?.name ?? 'this document';
        const ok = await showMessageModal({ title: 'Delete', message: `Delete "${name}"? This cannot be undone.`, okText: 'Delete', cancelText: 'Cancel', danger: true });
        if (!ok) return;
        await deleteDoc(id);
        if (id === deps.getCurrentDocId()) {
          await deps.setCurrentDocId(null);
        }
        await renderList();
        if (closeBtn) closeBtn.style.display = deps.getCurrentDocId() ? '' : 'none';
      }
      return;
    }
    const area = (e.target as HTMLElement).closest('.fm-open-area[data-id]') as HTMLElement | null;
    if (area) {
      await deps.openDoc(area.dataset.id!);
      close();
    }
  };
}

export async function importStencilFile(
  file: File,
  openDoc: (id: string) => Promise<void>,
): Promise<void> {
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
    const meta = await createDoc(name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDoc(meta.id, raw as any);
    await openDoc(meta.id);
  } catch (e) {
    await showMessageModal({ title: 'Import Stencil', message: `Import failed: ${e}` });
  }
}
