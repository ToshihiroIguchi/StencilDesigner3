import { parse, type Font } from 'opentype.js';

let cached: Font | null = null;
let pending: Promise<Font> | null = null;

export function getCachedFont(): Font | null { return cached; }

export async function loadFont(): Promise<Font> {
  if (cached) return cached;
  if (pending) return pending;
  pending = fetch('/fonts/BigShouldersStencilDisplay-Regular.ttf')
    .then(r => {
      if (!r.ok) throw new Error(`Font load failed: ${r.status}`);
      return r.arrayBuffer();
    })
    .then(buf => {
      cached = parse(buf);
      return cached;
    });
  return pending;
}
