export interface TextareaOverlayCallbacks {
  onCommit: (text: string) => void;
  onDiscard: () => void;
  onInput?: (text: string, el: HTMLTextAreaElement) => void;
  syncStyle?: () => void;
}

export interface TextareaOverlayOptions {
  elementId: string;
  hintElementId?: string;
  hintEditing?: string;
  hintIdle?: string;
  allowNewlines?: boolean;
  filterInput?: (raw: string) => string;
}

/** Manages the lifecycle of a positioned textarea overlay (show/hide/events/blur-timer). */
export class TextareaOverlay {
  private readonly el: HTMLTextAreaElement | null;
  private readonly hint: HTMLElement | null;
  private readonly opts: TextareaOverlayOptions;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: TextareaOverlayCallbacks | null = null;
  private _isOpen = false;

  private readonly boundKeyDown: (e: KeyboardEvent) => void;
  private readonly boundInput: () => void;

  constructor(opts: TextareaOverlayOptions) {
    this.opts = opts;
    this.el = document.getElementById(opts.elementId) as HTMLTextAreaElement | null;
    this.hint = opts.hintElementId
      ? (document.getElementById(opts.hintElementId) as HTMLElement | null)
      : null;
    this.boundKeyDown = (e) => this.handleKeyDown(e);
    this.boundInput = () => this.handleInput();
  }

  get isOpen(): boolean { return this._isOpen; }

  /** Current (filtered) value of the textarea. Empty string when closed. */
  get value(): string { return this.el?.value ?? ''; }

  open(
    canvasPt: { x: number; y: number },
    initialText: string,
    cbs: TextareaOverlayCallbacks,
  ): void {
    if (!this.el) return;
    this.callbacks = cbs;

    this.el.value = initialText;
    this.el.style.left = `${canvasPt.x}px`;
    this.el.style.top = `${canvasPt.y}px`;
    this.el.style.display = '';
    this._isOpen = true;

    // syncStyle after display is set so scrollHeight is valid
    cbs.syncStyle?.();

    this.el.addEventListener('keydown', this.boundKeyDown);
    this.el.addEventListener('input', this.boundInput);
    this.el.addEventListener('blur', () => {
      this.blurTimer = setTimeout(() => {
        this.blurTimer = null;
        this.commit();
      }, 80);
    }, { once: true });

    setTimeout(() => { this.el?.focus(); this.el?.select(); }, 0);
    if (this.hint && this.opts.hintEditing) this.hint.textContent = this.opts.hintEditing;
  }

  cancelBlurTimer(): void {
    if (this.blurTimer !== null) { clearTimeout(this.blurTimer); this.blurTimer = null; }
  }

  commit(): void {
    const text = this.el?.value ?? '';
    const cbs = this.callbacks;
    this.hide();
    cbs?.onCommit(text);
  }

  discard(): void {
    const cbs = this.callbacks;
    this.hide();
    cbs?.onDiscard();
  }

  private hide(): void {
    if (!this.el) return;
    this.el.removeEventListener('keydown', this.boundKeyDown);
    this.el.removeEventListener('input', this.boundInput);
    this.el.style.display = 'none';
    this.el.value = '';
    this._isOpen = false;
    this.callbacks = null;
    if (this.hint && this.opts.hintIdle) this.hint.textContent = this.opts.hintIdle;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      if (this.opts.allowNewlines && e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      this.cancelBlurTimer();
      this.commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancelBlurTimer();
      this.discard();
    }
  }

  private handleInput(): void {
    if (!this.el) return;
    if (this.opts.filterInput) {
      const filtered = this.opts.filterInput(this.el.value);
      if (filtered !== this.el.value) this.el.value = filtered;
    }
    this.callbacks?.onInput?.(this.el.value, this.el);
  }
}
