import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

export default defineConfig({
  root: '.',
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      // The package's "exports" entry resolves the bare specifier to dist/libredwg-web.js,
      // which inlines the entire ~6.3MB wasm as a base64 data: URL. We never use that inline
      // copy (we vendor the wasm and pass locateFile in src/dwg/libredwg.ts), so it just bloats
      // the lazy DWG worker chunk to ~8.6MB. Alias to the lib/ entry instead, which loads the
      // wasm via a separate file (locateFile) and carries no inline base64; the worker chunk
      // shrinks to ~194KB. The exports map hides lib/index.js as a subpath, so we resolve the
      // file directly here. tsc still resolves the bare specifier via the package "types" field.
      '@mlightcad/libredwg-web': fileURLToPath(
        new URL('./node_modules/@mlightcad/libredwg-web/lib/index.js', import.meta.url)
      ),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  optimizeDeps: {
    // Force pre-bundling of the aliased libredwg-web (its lib/ entry uses extensionless
    // directory imports and the emscripten loader contains a new URL(..., import.meta.url)).
    // Pre-bundling with esbuild resolves those and keeps Vite's new URL transform from
    // emitting a duplicate copy of the wasm; the only wasm asset is our vendored ?url one.
    include: ['clipper-lib', 'dxf-parser', 'localforage', '@mlightcad/libredwg-web'],
  },
});
