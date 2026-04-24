/**
 * Source-level regression guard for Suggest Mode edit routing.
 *
 * Why this test exists
 * --------------------
 * The initial Suggest Mode implementation called
 * `this._suggestEngine.enable()` but threw away the returned buffer.
 * CodeMirror/Tiptap stayed bound to the shared Y.Text, so local
 * "suggestions" leaked to peers and the pending-change detector
 * compared two identical strings (buffer == base) forever.
 *
 * The fix: `_handleSuggestToggle(true)` must capture `bufferText` from
 * `enable()` and call `binding.rebindSharedText(bufferText)`. The
 * disable path must rebind back to the shared Y.Text BEFORE tearing
 * down the buffer so yCollab isn't left pointing at a destroyed Y.Text.
 *
 * A full behavioural test lives in
 * `suggest-engine-routing.test.ts`. This one is a cheap static check
 * that the code in `multi-editor.ts` still wires the pieces together.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const multiEditorSrc = readFileSync(
  resolve(__dirname, '..', 'multi-editor.ts'),
  'utf8',
);

describe('multi-editor suggest-mode routing guard', () => {
  test('captures bufferText from suggestEngine.enable()', () => {
    // The toggle handler must destructure the return value. A regression
    // would either ignore the return (`suggestEngine.enable()` standalone)
    // or discard it.
    expect(multiEditorSrc).toMatch(
      /const\s*\{\s*bufferText[^}]*\}\s*=\s*this\._suggestEngine\.enable\s*\(/,
    );
  });

  test('calls binding.rebindSharedText with the buffer Y.Text on enable', () => {
    // Order matters: must see `rebindSharedText(bufferText)` near the
    // enable site.
    expect(multiEditorSrc).toMatch(
      /rebindSharedText\s*\(\s*bufferText\s*\)/,
    );
  });

  test('rebinds back to the editor-side Y.Text on disable', () => {
    // Disable path must rebind to the editor-side Y.Text so the editor
    // isn't pointing at a Y.Text that suggestEngine.disable() is about to
    // destroy. Post-syncDoc/editorDoc split, this is `editorText`.
    expect(multiEditorSrc).toMatch(
      /rebindSharedText\s*\(\s*this\._collabProvider\.editorText\s*\)/,
    );
  });

  test('rebinds around clear() in discard and commit paths', () => {
    // _handleSuggestDiscard and _commitPendingSuggestion both call
    // suggestEngine.clear() which destroys the old buffer and creates a
    // new one. The editor must be rebound to the new buffer afterwards
    // via getBufferText().
    expect(multiEditorSrc).toMatch(/this\._suggestEngine\.getBufferText\s*\(/);
  });
});
