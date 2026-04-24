/**
 * Source-level regression guard for Suggest Mode wiring.
 *
 * In the new syncDoc/editorDoc model, Suggest Mode is a thin controller
 * over the replicator's outbound gate + an editorDoc reset on exit.
 * There is no buffer Y.Doc, no rebind-on-enable, and no rebindSharedText
 * in the suggest toggle/commit/discard handlers.
 *
 * This guard catches accidental reintroduction of the old buffer-and-rebind
 * machinery. The full behavioural coverage lives in suggest-engine.test.ts
 * and suggest-engine-routing.test.ts.
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

describe('multi-editor suggest-mode wiring guard (syncDoc/editorDoc split)', () => {
  test('SuggestEngine is constructed with the collaboration provider', () => {
    // The new SuggestEngine signature is `(collab, config)`. A regression
    // would pass `(ydoc, sharedText, config)` as before.
    expect(multiEditorSrc).toMatch(
      /new SuggestEngine\s*\(\s*this\._collabProvider\s*,/,
    );
  });

  test('enable captures the editor-native serialized text', () => {
    // Enable takes the enable-time "before" snapshot so diff captures are
    // symmetric (same serializer on both sides). Regression would call
    // enable() with no arg.
    expect(multiEditorSrc).toMatch(
      /this\._suggestEngine\.enable\s*\(\s*currentText\s*\)/,
    );
  });

  test('onEditorDocReset subscription rebinds the editor', () => {
    // resetEditorDoc fires the callback after swapping editorDoc. Bindings
    // MUST rebind to the new editorText or they keep pointing at the
    // destroyed Y.Text.
    expect(multiEditorSrc).toMatch(/onEditorDocReset\s*\(/);
    expect(multiEditorSrc).toMatch(
      /rebindSharedText\s*\(\s*this\._collabProvider\.editorText\s*\)/,
    );
  });

  test('commit path calls SuggestEngine.commit (not buildSuggestion + manual revert)', () => {
    // The engine's commit() bundles build + resetEditorDoc + disable so
    // the three happen atomically. A regression would call buildSuggestion
    // alone and forget to revert.
    expect(multiEditorSrc).toMatch(
      /this\._suggestEngine\.commit\s*\(/,
    );
  });

  test('discard path calls SuggestEngine.discard (not engine.clear + rebind)', () => {
    // clear() was the old API. The new API is discard() which handles
    // reset + gate reopen internally.
    expect(multiEditorSrc).toMatch(
      /this\._suggestEngine\.discard\s*\(/,
    );
    // Ensure the old buffer-swap dance is gone.
    expect(multiEditorSrc).not.toMatch(
      /this\._suggestEngine\.getBufferText\s*\(/,
    );
    expect(multiEditorSrc).not.toMatch(
      /this\._suggestEngine\.clear\s*\(/,
    );
  });
});
