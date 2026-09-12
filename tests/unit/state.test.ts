import { describe, it, expect, beforeEach } from 'vitest';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import { AddShapeCommand, DeleteCommand, MoveCommand, SetSelectionCommand, ImportBatchCommand } from '../../src/state/commands';
import { rectToPolygon } from '../../src/core/geometry';
import type { Layer } from '../../src/types';

function makeTestState() {
  return createDefaultState();
}

describe('History (undo/redo)', () => {
  let history: History;

  beforeEach(() => {
    history = new History(makeTestState());
  });

  it('executes command and updates state', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    const cmd = new AddShapeCommand(poly);
    history.execute(cmd);
    expect(history.state.shapes.length).toBe(1);
  });

  it('undoes command', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    history.execute(new AddShapeCommand(poly));
    expect(history.state.shapes.length).toBe(1);
    history.undo();
    expect(history.state.shapes.length).toBe(0);
  });

  it('redoes after undo', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    history.execute(new AddShapeCommand(poly));
    history.undo();
    history.redo();
    expect(history.state.shapes.length).toBe(1);
  });

  it('clears redo stack on new command', () => {
    const poly1 = rectToPolygon(0, 0, 100, 100);
    const poly2 = rectToPolygon(200, 200, 300, 300);
    history.execute(new AddShapeCommand(poly1));
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.execute(new AddShapeCommand(poly2));
    expect(history.canRedo()).toBe(false);
  });

  it('sequence: add -> move -> undo -> state matches pre-move', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    history.execute(new AddShapeCommand(poly));
    const addedId = history.state.shapes[0].id;

    // Select and move
    const sel = [{ type: 'polygon' as const, shapeId: addedId, index: -1, holeIndex: -1 }];
    history.execute(new SetSelectionCommand(sel, []));
    history.execute(new MoveCommand(sel, 500, 300));

    const movedShape = history.state.shapes.find((s) => s.id === addedId)!;
    expect(movedShape.outer[0].x).toBe(500);

    history.undo(); // undo move
    const restoredShape = history.state.shapes.find((s) => s.id === addedId)!;
    expect(restoredShape.outer[0].x).toBe(0);
  });

  it('undo/redo returns identical state', () => {
    const poly = rectToPolygon(0, 0, 100, 100);
    history.execute(new AddShapeCommand(poly));
    const snapBefore = history.snapshot();

    const sel = [{ type: 'polygon' as const, shapeId: poly.id, index: -1, holeIndex: -1 }];
    history.execute(new MoveCommand(sel, 200, 100));
    history.undo();

    const snapAfter = history.snapshot();
    expect(snapAfter.shapes[0].outer).toEqual(snapBefore.shapes[0].outer);
  });

  it('respects max stack size of 50', () => {
    for (let i = 0; i < 60; i++) {
      const poly = rectToPolygon(i * 100, 0, i * 100 + 100, 100);
      history.execute(new AddShapeCommand(poly));
    }
    // Stack should be capped; we can still undo at least 50 times but not 60
    let undoCount = 0;
    while (history.canUndo()) {
      history.undo();
      undoCount++;
    }
    expect(undoCount).toBeLessThanOrEqual(50);
  });

  it('returns false from undo/redo when stack is empty', () => {
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('SetSelectionCommand undoes and redoes selection state', () => {
    const selBefore = history.state.selection;
    const newSel = [{ type: 'polygon' as const, shapeId: 'test-id', index: -1, holeIndex: -1 }];

    history.execute(new SetSelectionCommand(newSel, selBefore));
    expect(history.state.selection).toEqual(newSel);

    history.undo();
    expect(history.state.selection).toEqual(selBefore);

    history.redo();
    expect(history.state.selection).toEqual(newSel);
  });
});

describe('DeleteCommand', () => {
  it('restores deleted shapes on undo', () => {
    const history = new History(makeTestState());
    const poly = rectToPolygon(0, 0, 100, 100);
    history.execute(new AddShapeCommand(poly));
    const id = history.state.shapes[0].id;
    const sel = [{ type: 'polygon' as const, shapeId: id, index: -1, holeIndex: -1 }];

    history.execute(new DeleteCommand(sel));
    expect(history.state.shapes.length).toBe(0);

    history.undo();
    expect(history.state.shapes.length).toBe(1);
  });
});

describe('ImportBatchCommand', () => {
  it('adds multiple shapes and new layers atomically', () => {
    const history = new History(makeTestState());
    const poly1 = { ...rectToPolygon(0, 0, 100, 100), layer: 'PASTE_TOP' };
    const poly2 = { ...rectToPolygon(200, 200, 300, 300), layer: 'OUTLINE' };
    const newLayers: Layer[] = [
      { name: 'PASTE_TOP', color: '#ff0000', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: true },
      { name: 'OUTLINE', color: '#00ff00', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: false },
      { name: '0', color: '#ffffff', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: true }, // already exists
    ];

    const cmd = new ImportBatchCommand(newLayers, [poly1, poly2]);
    history.execute(cmd);

    expect(history.state.shapes.length).toBe(2);
    expect(history.state.layers.some((l) => l.name === 'PASTE_TOP')).toBe(true);
    expect(history.state.layers.some((l) => l.name === 'OUTLINE')).toBe(true);
    // Should not duplicate layer '0'
    expect(history.state.layers.filter((l) => l.name === '0').length).toBe(1);

    // Single undo removes both shapes and the newly added layers
    history.undo();
    expect(history.state.shapes.length).toBe(0);
    expect(history.state.layers.some((l) => l.name === 'PASTE_TOP')).toBe(false);
    expect(history.state.layers.some((l) => l.name === 'OUTLINE')).toBe(false);
    expect(history.state.layers.some((l) => l.name === '0')).toBe(true);

    // Redo restores both shapes and layers
    history.redo();
    expect(history.state.shapes.length).toBe(2);
    expect(history.state.layers.some((l) => l.name === 'PASTE_TOP')).toBe(true);
    expect(history.state.layers.some((l) => l.name === 'OUTLINE')).toBe(true);
  });
});

