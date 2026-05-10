import type { Vertex } from '../types';

let _counter = 0;

export function vertex(x: number, y: number, id?: string): Vertex {
  return {
    x: Math.round(x),
    y: Math.round(y),
    id: id ?? `v${Date.now().toString(36)}_${(_counter++).toString(36)}`,
  };
}
