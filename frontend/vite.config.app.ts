import { defineConfig } from 'vite';

// App build config — processes index.html and bundles everything for static serving
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: false,
  },
});
