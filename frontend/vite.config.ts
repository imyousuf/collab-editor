import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    lib: {
      entry: 'src/multi-editor.ts',
      formats: ['es'],
      fileName: 'multi-editor',
    },
    target: 'esnext',
    minify: 'esbuild',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
