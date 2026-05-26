import { UnitConverter } from '../core/format';

type Unit = 'mm' | 'um';

export interface MessageModalOptions {
  title: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function showMessageModal(opts: MessageModalOptions): Promise<boolean> {
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

export interface InputModalOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  okText?: string;
}

export function showInputModal(opts: InputModalOptions): Promise<string | null> {
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

export interface DuplicateModalInitial {
  countX: number;
  countY: number;
  pitchX: number;
  pitchY: number;
  unit: Unit;
}

export interface DuplicateModalResult {
  nx: number;
  ny: number;
  pitchX: number;
  pitchY: number;
}

export function showDuplicateModal(
  initial: DuplicateModalInitial,
): Promise<DuplicateModalResult | null> {
  return new Promise((resolve) => {
    const modal = document.getElementById('duplicate-modal') as HTMLElement;
    const nxInput = document.getElementById('duplicate-modal-nx') as HTMLInputElement;
    const nyInput = document.getElementById('duplicate-modal-ny') as HTMLInputElement;
    const pxInput = document.getElementById('duplicate-modal-px') as HTMLInputElement;
    const pyInput = document.getElementById('duplicate-modal-py') as HTMLInputElement;
    const okBtn = document.getElementById('duplicate-modal-ok') as HTMLButtonElement;
    const cancelBtn = document.getElementById('duplicate-modal-cancel') as HTMLButtonElement;
    const { unit } = initial;
    nxInput.value = String(Math.max(0, initial.countX));
    nyInput.value = String(Math.max(0, initial.countY));
    pxInput.value = UnitConverter.formatOutput(initial.pitchX, unit);
    pyInput.value = UnitConverter.formatOutput(initial.pitchY, unit);
    modal.style.display = '';
    nxInput.focus();
    nxInput.select();
    const close = (result: DuplicateModalResult | null) => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => {
      const nx = parseInt(nxInput.value, 10);
      const ny = parseInt(nyInput.value, 10);
      const pitchX = UnitConverter.parseInput(pxInput.value, unit);
      const pitchY = UnitConverter.parseInput(pyInput.value, unit);
      if (isNaN(nx) || isNaN(ny) || nx < 0 || ny < 0) return;
      if (nx === 0 && ny === 0) return;
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
