import { defineConfig } from 'vite';
import path from 'path';

const pmPath = (pkg: string) => path.resolve(__dirname, 'node_modules', pkg);

// App build config — processes index.html and bundles everything for static serving.
// ProseMirror packages must be deduplicated to avoid the multiple-instance problem
// where instanceof checks fail across separate bundle copies.
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: 'esbuild',
  },
  resolve: {
    alias: {
      'prosemirror-model': pmPath('prosemirror-model'),
      'prosemirror-state': pmPath('prosemirror-state'),
      'prosemirror-view': pmPath('prosemirror-view'),
      'prosemirror-transform': pmPath('prosemirror-transform'),
      'prosemirror-keymap': pmPath('prosemirror-keymap'),
      'prosemirror-commands': pmPath('prosemirror-commands'),
      'prosemirror-schema-list': pmPath('prosemirror-schema-list'),
      'prosemirror-inputrules': pmPath('prosemirror-inputrules'),
      'prosemirror-dropcursor': pmPath('prosemirror-dropcursor'),
      'prosemirror-gapcursor': pmPath('prosemirror-gapcursor'),
      'prosemirror-history': pmPath('prosemirror-history'),
      'prosemirror-collab': pmPath('prosemirror-collab'),
      'prosemirror-tables': pmPath('prosemirror-tables'),
    },
    dedupe: [
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-view',
      'prosemirror-transform',
      'yjs',
    ],
  },
});
