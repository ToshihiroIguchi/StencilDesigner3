import { describe, it, expect } from 'vitest';
import { createDefaultState, defaultLayers } from '../../src/types';
import {
  AddLayerCommand, DeleteLayerCommand, RenameLayerCommand,
  UpdateLayerStyleCommand, MoveShapesToLayerCommand,
  AddShapeCommand,
} from '../../src/state/commands';
import { rectToPolygon } from '../../src/core/geometry';

describe('Layer commands', () => {
  it('createDefaultState has 3 layers with activeLayerName=0', () => {
    const s = createDefaultState();
    expect(s.layers).toHaveLength(3);
    expect(s.activeLayerName).toBe('0');
    expect(s.schemaVersion).toBe(2);
  });

  it('AddLayerCommand adds and undoes', () => {
    const s = createDefaultState();
    const cmd = new AddLayerCommand({
      name: 'TEST', color: '#ff0000', linetype: 'CONTINUOUS',
      lineweight: -1, visible: true, locked: false, plot: true, isAperture: false,
    });
    const s2 = cmd.do(s);
    expect(s2.layers).toHaveLength(4);
    expect(s2.layers.find((l) => l.name === 'TEST')).toBeDefined();
    const s3 = cmd.undo(s2);
    expect(s3.layers).toHaveLength(3);
    expect(s3.layers.find((l) => l.name === 'TEST')).toBeUndefined();
  });

  it('AddLayerCommand ignores duplicate name', () => {
    const s = createDefaultState();
    const cmd = new AddLayerCommand({ name: '0', color: '#ff0000', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: false });
    const s2 = cmd.do(s);
    expect(s2.layers).toHaveLength(3); // no change
  });

  it('DeleteLayerCommand mode=move shifts shapes to target', () => {
    let s = createDefaultState();
    const poly = rectToPolygon(0, 0, 1000, 1000, '0');
    s = new AddShapeCommand(poly).do(s);
    expect(s.shapes[0].layer).toBe('0');

    const cmd = new DeleteLayerCommand('0', 'move', 'OUTLINE');
    const s2 = cmd.do(s);
    expect(s2.layers.find((l) => l.name === '0')).toBeUndefined();
    expect(s2.shapes[0].layer).toBe('OUTLINE');

    const s3 = cmd.undo(s2);
    expect(s3.layers.find((l) => l.name === '0')).toBeDefined();
    expect(s3.shapes[0].layer).toBe('0');
  });

  it('DeleteLayerCommand mode=delete removes shapes', () => {
    let s = createDefaultState();
    const poly = rectToPolygon(0, 0, 1000, 1000, '0');
    s = new AddShapeCommand(poly).do(s);
    const cmd = new DeleteLayerCommand('0', 'delete');
    const s2 = cmd.do(s);
    expect(s2.shapes).toHaveLength(0);
    const s3 = cmd.undo(s2);
    expect(s3.shapes).toHaveLength(1);
  });

  it('DeleteLayerCommand refuses to delete last layer', () => {
    let s = createDefaultState();
    // delete OUTLINE and DIMENSIONS first
    s = new DeleteLayerCommand('OUTLINE', 'delete').do(s);
    s = new DeleteLayerCommand('DIMENSIONS', 'delete').do(s);
    expect(s.layers).toHaveLength(1);
    const s2 = new DeleteLayerCommand('0', 'delete').do(s);
    expect(s2.layers).toHaveLength(1); // no change
  });

  it('RenameLayerCommand updates shapes and activeLayerName', () => {
    let s = createDefaultState();
    const poly = rectToPolygon(0, 0, 1000, 1000, '0');
    s = new AddShapeCommand(poly).do(s);
    const cmd = new RenameLayerCommand('0', 'PASTE');
    const s2 = cmd.do(s);
    expect(s2.layers.find((l) => l.name === 'PASTE')).toBeDefined();
    expect(s2.layers.find((l) => l.name === '0')).toBeUndefined();
    expect(s2.shapes[0].layer).toBe('PASTE');
    expect(s2.activeLayerName).toBe('PASTE');
    const s3 = cmd.undo(s2);
    expect(s3.activeLayerName).toBe('0');
    expect(s3.shapes[0].layer).toBe('0');
  });

  it('RenameLayerCommand ignores duplicate name', () => {
    const s = createDefaultState();
    const s2 = new RenameLayerCommand('0', 'OUTLINE').do(s);
    expect(s2.layers).toHaveLength(3); // no change
    expect(s2.layers.find((l) => l.name === '0')).toBeDefined();
  });

  it('UpdateLayerStyleCommand changes isAperture', () => {
    const s = createDefaultState();
    const cmd = new UpdateLayerStyleCommand('0', { isAperture: false });
    const s2 = cmd.do(s);
    expect(s2.layers.find((l) => l.name === '0')?.isAperture).toBe(false);
    const s3 = cmd.undo(s2);
    expect(s3.layers.find((l) => l.name === '0')?.isAperture).toBe(true);
  });

  it('MoveShapesToLayerCommand moves shapes and undoes', () => {
    let s = createDefaultState();
    const poly = rectToPolygon(0, 0, 1000, 1000, '0');
    s = new AddShapeCommand(poly).do(s);
    const sel = [{ type: 'polygon' as const, shapeId: poly.id, index: -1, holeIndex: -1 }];
    const cmd = new MoveShapesToLayerCommand(sel, 'OUTLINE');
    const s2 = cmd.do(s);
    expect(s2.shapes[0].layer).toBe('OUTLINE');
    const s3 = cmd.undo(s2);
    expect(s3.shapes[0].layer).toBe('0');
  });
});

describe('Schema migration', () => {
  it('defaultLayers returns 3 layers', () => {
    const layers = defaultLayers();
    expect(layers).toHaveLength(3);
    expect(layers[0].name).toBe('0');
    expect(layers[0].isAperture).toBe(true);
    expect(layers[1].name).toBe('OUTLINE');
    expect(layers[1].isAperture).toBe(false);
  });
});
