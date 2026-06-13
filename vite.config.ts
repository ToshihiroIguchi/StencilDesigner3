import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: process.env.VITE_BASE ?? '/',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  optimizeDeps: {
    // The libredwg-web distribution inlines the wasm into the JS as a data: URL.
    // Pre-bundling (esbuild) keeps the data: URL as a literal string so emscripten
    // can decode it inline. Excluding it instead lets Vite's new URL(...) transform
    // mangle the data: URL into a fetch that fails, so include it to force pre-bundling.
    include: ['clipper-lib', 'dxf-parser', 'localforage', '@mlightcad/libredwg-web'],
  },
});
