// Web Worker that parses DWG off the main thread.
// Receives { buf } from the main thread, runs importDwg, and returns the
// ImportResult (structured-clone-safe plain data). On failure returns { error }.
// The WASM is loaded inside this worker so the main thread is never blocked.

import { importDwg } from './importer';

interface RequestMessage {
  buf: ArrayBuffer;
}

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  try {
    const result = await importDwg(e.data.buf);
    // ImportResult is composed only of plain objects (Polygon/Layer/etc.).
    (self as unknown as Worker).postMessage({ result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
