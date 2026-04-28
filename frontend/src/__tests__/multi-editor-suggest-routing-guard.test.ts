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

  test('suggestion preview applies to editorText with outbound gate closed', () => {
    // C9: when a reviewer activates a pending suggestion, the diff is
    // applied to their *local* editorDoc (not syncDoc). The outbound
    // gate must be closed so the preview never leaks to peers.
    expect(multiEditorSrc).toMatch(/replicator\.outboundOpen\s*=\s*false/);
    expect(multiEditorSrc).toMatch(/tryApplyTextSuggestion\s*\(\s*editorText\s*,/);
  });

  test('ending a preview resets editorDoc (no tombstone residue)', () => {
    // _endSuggestionPreview calls resetEditorDoc() to wipe the preview
    // ops rather than trying to undo them in place.
    expect(multiEditorSrc).toMatch(
      /_endSuggestionPreview\s*\(\s*\)\s*:[\s\S]{0,1000}?resetEditorDoc\s*\(\s*\)/,
    );
  });

  test('onContentChange skips pending-count update while a preview is active', () => {
    // Regression: when the author previewed their own pending suggestion
    // in Suggest Mode, the preview's text change fired onContentChange
    // which misread the preview as a user draft → "1 pending change"
    // lit up falsely.
    const onChangeRegion = multiEditorSrc.slice(
      multiEditorSrc.indexOf("onContentChange((content)"),
    );
    expect(onChangeRegion).toMatch(/if\s*\(\s*this\._previewingThreadId\s*\)/);
    // The preview guard must appear before the hasPendingChanges check
    // to actually suppress the count.
    const guardIdx = onChangeRegion.indexOf('_previewingThreadId');
    const pendingIdx = onChangeRegion.indexOf('hasPendingChanges');
    expect(guardIdx).toBeGreaterThan(0);
    expect(pendingIdx).toBeGreaterThan(guardIdx);
  });

  test('accept handler ends preview before applying to syncText', () => {
    // Order matters: resetting editorDoc first ensures no preview residue
    // gets stacked with the incoming inbound replication of the accept op.
    const methodStart = multiEditorSrc.indexOf(
      'private async _handleCommentSuggestionAccept',
    );
    expect(methodStart).toBeGreaterThan(0);
    const acceptRegion = multiEditorSrc.slice(methodStart);
    const setActiveIdx = acceptRegion.indexOf('_setActiveCommentThread(null)');
    const tryApplyIdx = acceptRegion.indexOf('tryApplyTextSuggestion(');
    expect(setActiveIdx).toBeGreaterThan(0);
    expect(tryApplyIdx).toBeGreaterThan(setActiveIdx);
  });

  test('panel position is captured BEFORE the preview mutes carets', () => {
    // Regression: muting decorations removed the DOM anchor that
    // _positionCommentPanelNear measures. The panel then fell back to
    // the top-left default and covered the document title.
    const setActiveRegion = multiEditorSrc.slice(
      multiEditorSrc.indexOf('_setActiveCommentThread('),
    );
    const positionIdx = setActiveRegion.indexOf(
      '_positionCommentPanelNear(thread.id)',
    );
    const startPreviewIdx = setActiveRegion.indexOf('_startSuggestionPreview(thread)');
    expect(positionIdx).toBeGreaterThan(0);
    expect(startPreviewIdx).toBeGreaterThan(positionIdx);
  });

  test('preview start mutes decorations, end unmutes them', () => {
    // Carets and anchor highlights are computed against syncText; once
    // editorText diverges (preview), they drift. Muting the coordinator
    // hides them for the duration of the preview.
    const startRegion = multiEditorSrc.slice(
      multiEditorSrc.indexOf('_startSuggestionPreview'),
    );
    expect(startRegion).toMatch(/setDecorationsMuted\s*\(\s*true\s*\)/);

    const endRegion = multiEditorSrc.slice(
      multiEditorSrc.indexOf('_endSuggestionPreview'),
    );
    expect(endRegion).toMatch(/setDecorationsMuted\s*\(\s*false\s*\)/);
  });

  test('top suggestion diff bar is hidden during preview', () => {
    // The editor itself shows the previewed change in-place, so the
    // top diff bar duplicating that information is confusing.
    expect(multiEditorSrc).toMatch(
      /_activeCommentThread\?\.suggestion\s*&&\s*!this\._previewingThreadId/,
    );
  });

  test('accept handler refreshes SuggestEngine baseline (stale-baseline regression)', () => {
    // Regression: when a reviewer in Suggest Mode accepts a peer's
    // suggestion, applyStringDiff lands on syncText and (via the
    // replicator) editorText. The SuggestEngine's _textAtEnable stays
    // pinned to the pre-accept text, so hasPendingChanges() then
    // false-positives and the next toolbar "Exit" surfaces a
    // "submit pending suggestions?" prompt for nothing. The fix is to
    // call rebase() (or equivalent disable()/enable()) inside the
    // accept handler after the diff lands.
    const acceptStart = multiEditorSrc.indexOf(
      'private async _handleCommentSuggestionAccept',
    );
    expect(acceptStart).toBeGreaterThan(0);
    const acceptRegion = multiEditorSrc.slice(acceptStart, acceptStart + 3000);
    expect(acceptRegion).toMatch(/this\._suggestEngine\.rebase\s*\(/);
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
