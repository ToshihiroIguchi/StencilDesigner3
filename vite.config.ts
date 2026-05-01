import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  optimizeDeps: {
    include: ['clipper-lib', 'dxf-parser', 'localforage'],
  },
});
