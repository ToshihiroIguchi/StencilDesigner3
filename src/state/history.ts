import type { AppState, Command } from '../types';

const MAX_STACK = 50;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private currentState: AppState;

  constructor(initialState: AppState) {
    this.currentState = initialState;
  }

  get state(): AppState {
    return this.currentState;
  }

  execute(command: Command): void {
    this.currentState = command.do(this.currentState);
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_STACK) {
      this.undoStack.shift();
    }
    this.redoStack = []; // Clear redo on new action
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this.currentState = cmd.undo(this.currentState);
    this.redoStack.push(cmd);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this.currentState = cmd.do(this.currentState);
    this.undoStack.push(cmd);
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Replace current state without recording (used for loading). */
  loadState(state: AppState): void {
    this.currentState = state;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Snapshot current state for serialization. */
  snapshot(): AppState {
    return JSON.parse(JSON.stringify(this.currentState));
  }
}
