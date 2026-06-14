// Lazy loader for LibreDWG (WASM).
// The WASM binary (~6.3MB) is kept out of the initial bundle and only loaded the
// first time a DWG is imported.
//
// We vendor the .wasm and import it with `?url` so Vite emits it as a real, hashed
// asset (a separate file, never inlined). The libredwg-web distribution otherwise
// inlines the wasm as a `data:application/wasm;base64,` URL, which emscripten's
// isDataURI() (it only recognizes `application/octet-stream`) tries to *fetch* and
// fails on. By passing `locateFile` that always returns our real asset URL, the
// module fetches the proper .wasm file in both dev and production.

import wasmUrl from './libredwg-web.wasm?url';
import type { LibreDwgEx } from '@mlightcad/libredwg-web';

let instance: LibreDwgEx | null = null;
let loading: Promise<LibreDwgEx> | null = null;

/**
 * Returns the LibreDWG instance, loading the WASM on first call and caching it.
 * Concurrent callers share a single loading Promise so the WASM loads only once.
 */
export async function getLibreDwg(): Promise<LibreDwgEx> {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      const { LibreDwg, createModule } = await import('@mlightcad/libredwg-web');
      // Ignore the requested filename and always resolve to our emitted asset URL.
      const mod = await createModule({ locateFile: () => wasmUrl });
      instance = LibreDwg.createByWasmInstance(mod);
      return instance;
    })().catch((e) => {
      loading = null; // reset on failure so a later call can retry
      throw e;
    });
  }
  return loading;
}
