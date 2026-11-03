import { describe, it, expect, vi } from 'vitest';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import type { Layer } from '../../src/types';
import { DeleteLayerCommand, UpdateLayerStyleCommand } from '../../src/state/commands';
import { RectTool } from '../../src/tools/rect';
import { CircleTool } from '../../src/tools/circle';
import { PolygonTool } from '../../src/tools/polygon';
import type { ToolContext } from '../../src/tools/base';
import { TextareaOverlay } from '../../src/tools/textarea-overlay';
import { showMessageModal, showInputModal, showDuplicateModal } from '../../src/ui/modals';

function mkLayer(name: string, visible = true): Layer {
  return { ...createDefaultState().layers[0], name, visible };
}

function toolCtx(history: History): ToolContext {
  return {
    history,
    getSnap: (p) => ({ point: p, kind: 'none' } as never),
    getSelectionSnap: () => ({ delta: { x: 0, y: 0 }, kind: 'none', targetPoint: null } as never),
    requestRender: () => {},
    notify: () => {},
  };
}

function key(type: string, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  return e;
}

describe('layer commands', () => {
  it('hiding the active layer moves active to a visible layer; undo restores', () => {
    const s = createDefaultState();
    s.layers = [mkLayer('A'), mkLayer('B')];
    s.activeLayerName = 'A';
    const cmd = new UpdateLayerStyleCommand('A', { visible: false });
    const after = cmd.do(s);
    expect(after.activeLayerName).toBe('B');
    expect(cmd.undo(after).activeLayerName).toBe('A');
  });

  it('delete layer picks first visible non-DIMENSIONS layer; undo restores active and selection', () => {
    const s = createDefaultState();
    s.layers = [mkLayer('DIMENSIONS'), mkLayer('H', false), mkLayer('V'), mkLayer('X')];
    s.activeLayerName = 'X';
    s.selection = [{ type: 'polygon', shapeId: 's1', index: -1, holeIndex: -1 }];
    const cmd = new DeleteLayerCommand('X', 'delete');
    const after = cmd.do(s);
    expect(after.activeLayerName).toBe('V');
    expect(after.selection).toEqual([]);
    const back = cmd.undo(after);
    expect(back.activeLayerName).toBe('X');
    expect(back.selection).toEqual(s.selection);
  });
});

describe('rect/circle cancel during drag', () => {
  it('rect: Escape then mouse up does not commit', () => {
    const history = new History(createDefaultState());
    const tool = new RectTool(toolCtx(history));
    tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    tool.onMouseMove({ x: 5000, y: 5000 }, { x: 50, y: 50 }, false, history.state);
    tool.cancel();
    tool.onMouseUp({ x: 5000, y: 5000 }, { x: 50, y: 50 }, false, history.state);
    expect(history.canUndo()).toBe(false);
  });
  it('circle: Escape then mouse up does not commit', () => {
    const history = new History(createDefaultState());
    const tool = new CircleTool(toolCtx(history));
    tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    tool.onMouseMove({ x: 5000, y: 0 }, { x: 50, y: 0 }, false, history.state);
    tool.cancel();
    tool.onMouseUp({ x: 5000, y: 0 }, { x: 50, y: 0 }, false, history.state);
    expect(history.canUndo()).toBe(false);
  });
});

describe('polygon double-click on first vertex', () => {
  it('leaves no draft vertices', () => {
    const history = new History(createDefaultState());
    const tool = new PolygonTool(toolCtx(history));
    tool.onMouseDown({ x: 10, y: 10 }, { x: 10, y: 10 }, false, history.state);
    tool.onMouseDown({ x: 10, y: 10 }, { x: 10, y: 10 }, false, history.state);
    tool.commitFromDblClick(history.state);
    expect(tool.vertexCount()).toBe(0);
    expect(tool.isDrawing()).toBe(false);
  });
});

describe('TextareaOverlay', () => {
  function setup() {
    document.body.innerHTML = '<textarea id="ov"></textarea>';
    const el = document.getElementById('ov') as HTMLTextAreaElement;
    const ov = new TextareaOverlay({ elementId: 'ov' });
    return { el, ov };
  }
  it('ignores Enter during IME composition', () => {
    const { el, ov } = setup();
    const onCommit = vi.fn();
    ov.open({ x: 0, y: 0 }, 'a', { onCommit, onDiscard: () => {} });
    el.dispatchEvent(key('keydown', { key: 'Enter', isComposing: true }));
    el.dispatchEvent(key('keydown', { key: 'Enter', keyCode: 229 }));
    expect(onCommit).not.toHaveBeenCalled();
    el.dispatchEvent(key('keydown', { key: 'Enter' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  it('old blur does not close a re-opened overlay', () => {
    vi.useFakeTimers();
    try {
      const { el, ov } = setup();
      const first = vi.fn();
      const second = vi.fn();
      ov.open({ x: 0, y: 0 }, 'a', { onCommit: first, onDiscard: () => {} });
      el.dispatchEvent(new Event('blur'));
      ov.open({ x: 0, y: 0 }, 'b', { onCommit: second, onDiscard: () => {} });
      vi.advanceTimersByTime(200);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      expect(ov.isOpen).toBe(true);
      el.dispatchEvent(new Event('blur'));
      el.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(200);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('modals', () => {
  function dom() {
    document.body.innerHTML = `
      <div id="message-modal" style="display:none"><div id="message-modal-title"></div><div id="message-modal-msg"></div>
        <button id="message-modal-ok">OK</button><button id="message-modal-cancel">Cancel</button></div>
      <div id="input-modal" style="display:none"><div id="input-modal-title"></div><div id="input-modal-label"></div>
        <input id="input-modal-field"><button id="input-modal-ok">OK</button><button id="input-modal-cancel">Cancel</button></div>
      <div id="duplicate-modal" style="display:none"><div class="modal-box">
        <input id="duplicate-modal-nx"><input id="duplicate-modal-ny"><input id="duplicate-modal-px"><input id="duplicate-modal-py">
        <button id="duplicate-modal-ok">OK</button><button id="duplicate-modal-cancel">Cancel</button></div></div>`;
  }

  it('message modal: Enter on Cancel does not confirm; IME Enter ignored; Enter on OK confirms', async () => {
    dom();
    const p = showMessageModal({ title: 't', message: 'm', cancelText: 'Cancel' });
    const cancel = document.getElementById('message-modal-cancel') as HTMLElement;
    const ok = document.getElementById('message-modal-ok') as HTMLElement;
    const modal = document.getElementById('message-modal') as HTMLElement;
    cancel.dispatchEvent(key('keydown', { key: 'Enter' }));
    ok.dispatchEvent(key('keydown', { key: 'Enter', isComposing: true }));
    expect(modal.style.display).toBe('');
    ok.dispatchEvent(key('keydown', { key: 'Enter' }));
    expect(await p).toBe(true);
  });

  it('double open returns the same pending promise', async () => {
    dom();
    const a = showMessageModal({ title: 't', message: 'm' });
    const b = showMessageModal({ title: 't2', message: 'm2' });
    expect(b).toBe(a);
    (document.getElementById('message-modal-ok') as HTMLElement).click();
    expect(await a).toBe(true);
    const c = showMessageModal({ title: 't', message: 'm' });
    expect(c).not.toBe(a);
    (document.getElementById('message-modal-ok') as HTMLElement).click();
    await c;
  });

  it('input modal ignores IME Enter', async () => {
    dom();
    const p = showInputModal({ title: 't', defaultValue: 'x' });
    const field = document.getElementById('input-modal-field') as HTMLInputElement;
    field.dispatchEvent(key('keydown', { key: 'Enter', keyCode: 229 }));
    expect((document.getElementById('input-modal') as HTMLElement).style.display).toBe('');
    field.dispatchEvent(key('keydown', { key: 'Enter' }));
    expect(await p).toBe('x');
  });

  it('duplicate modal rejects oversized grids with a message', async () => {
    dom();
    const p = showDuplicateModal({ countX: 1, countY: 0, pitchX: 1000, pitchY: 1000, unit: 'um' });
    const nx = document.getElementById('duplicate-modal-nx') as HTMLInputElement;
    const ny = document.getElementById('duplicate-modal-ny') as HTMLInputElement;
    nx.value = '500';
    ny.value = '500';
    (document.getElementById('duplicate-modal-ok') as HTMLElement).click();
    const err = document.querySelector('.duplicate-modal-error') as HTMLElement;
    expect(err.textContent).not.toBe('');
    nx.value = '3';
    ny.value = '2';
    (document.getElementById('duplicate-modal-ok') as HTMLElement).click();
    const r = await p;
    expect(r?.nx).toBe(3);
  });
});
