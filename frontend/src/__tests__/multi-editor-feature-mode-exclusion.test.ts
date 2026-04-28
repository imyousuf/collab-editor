/**
 * Source-level guards for the mutual-exclusion invariant between Blame
 * View, Suggest Mode, and Comments mode (active thread / list panels).
 *
 * The three feature modes manipulate the same editor surface in
 * incompatible ways: Blame paints decorations across the doc, Suggest
 * Mode gates the replicator's outbound direction and treats edits as
 * drafts, Comments mode opens a thread-scoped panel and (for pending
 * suggestions) applies a preview to editorDoc. Letting them stack
 * produces fights — preview decorations under blame paint, suggest
 * drafts overlapping a preview, etc.
 *
 * These regex guards catch accidental removal of the "exit other modes
 * before activating mine" wiring. Behavioural coverage of each
 * transition lives next to it (suggest-engine tests, blame-coordinator
 * tests). Here we only assert the wiring exists.
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

describe('multi-editor feature-mode exclusion (Blame ⊥ Suggest ⊥ Comments)', () => {
  test('a private helper exits the conflicting modes before activating a new one', () => {
    // The helper centralises the "turn the others off" rule. Naming is
    // unimportant; the regex matches a method that takes a mode label
    // and dispatches per branch. Naming the helper avoids each call
    // site reinventing the dance and drifting.
    expect(multiEditorSrc).toMatch(
      /private\s+_activateFeatureMode\s*\(/,
    );
  });

  test('blame toggle activates exclusively (closes thread + panels, exits suggest)', () => {
    // _handleBlameToggle must route through the central helper when
    // turning ON, otherwise it can leave _activeCommentThread or
    // _suggestActive set.
    const start = multiEditorSrc.indexOf('private _handleBlameToggle');
    expect(start).toBeGreaterThan(0);
    const region = multiEditorSrc.slice(start, start + 800);
    expect(region).toMatch(
      /this\._activateFeatureMode\s*\(\s*['"]blame['"]/,
    );
  });

  test('suggest-mode enable activates exclusively (closes thread + panels, exits blame)', () => {
    const start = multiEditorSrc.indexOf('private _handleSuggestToggle');
    expect(start).toBeGreaterThan(0);
    const region = multiEditorSrc.slice(start, start + 1500);
    expect(region).toMatch(
      /this\._activateFeatureMode\s*\(\s*['"]suggest['"]/,
    );
  });

  test('opening a comment thread exits blame', () => {
    // _setActiveCommentThread is the single entry point for "user opened
    // a thread" — it must turn blame off, otherwise blame decorations
    // overlap the suggestion preview's diff bar.
    const start = multiEditorSrc.indexOf('private _setActiveCommentThread');
    expect(start).toBeGreaterThan(0);
    const region = multiEditorSrc.slice(start, start + 1500);
    expect(region).toMatch(
      /this\._activateFeatureMode\s*\(\s*['"]comments['"]/,
    );
  });

  test('opening the comments-list panel exits blame and suggest', () => {
    const start = multiEditorSrc.indexOf('private _handleCommentsListToggle');
    expect(start).toBeGreaterThan(0);
    const region = multiEditorSrc.slice(start, start + 600);
    // Only when transitioning to OPEN — closing the panel should NOT
    // poke other modes.
    expect(region).toMatch(
      /this\._activateFeatureMode\s*\(\s*['"]comments['"]/,
    );
  });

  test('opening the suggestions-list panel exits blame and suggest', () => {
    const start = multiEditorSrc.indexOf('private _handleSuggestionsListToggle');
    expect(start).toBeGreaterThan(0);
    const region = multiEditorSrc.slice(start, start + 600);
    expect(region).toMatch(
      /this\._activateFeatureMode\s*\(\s*['"]comments['"]/,
    );
  });

  test('toolbar reflects the constraint: blame button disabled while suggest active or comments open', () => {
    // The render path must propagate enough state to the toolbar so
    // each toggle button can grey out when another mode owns the
    // surface. We test by name — the toolbar already exposes the
    // matching .property bindings.
    expect(multiEditorSrc).toMatch(/\.blameDisabled\s*=\s*\$\{/);
    expect(multiEditorSrc).toMatch(/\.suggestDisabled\s*=\s*\$\{/);
    expect(multiEditorSrc).toMatch(/\.commentAddDisabled\s*=\s*\$\{/);
  });
});

describe('multi-editor orphaned-suggestion wiring', () => {
  // Regression guard for the "stale suggestion after undo+GC" case.
  // When a pending suggestion's anchor can no longer be resolved
  // (Y.RelativePosition dangling AND quoted-text fuzzy fallback
  // missing), the comment panel must surface this clearly: stale
  // banner, Accept disabled, Reject swapped for Dismiss. The
  // multi-editor is responsible for computing the orphan flag from
  // the engine and passing it to the panel.

  test('comment-panel render passes the orphan flag derived from the engine', () => {
    // Wiring shape: <comment-panel> tag in the render must bind
    // `.orphaned=${...isThreadOrphaned(activeId) ...}`. Naming is
    // flexible; the regex matches any expression that calls the
    // engine's orphan check inline.
    expect(multiEditorSrc).toMatch(
      /<comment-panel[\s\S]*?\.orphaned=\$\{[\s\S]*?isThreadOrphaned\b[\s\S]*?\}/,
    );
  });

  test('comment-suggestion-dismiss is wired to a handler', () => {
    // The panel emits this event when the user clicks Dismiss on a
    // stale suggestion. multi-editor must subscribe.
    expect(multiEditorSrc).toMatch(
      /@comment-suggestion-dismiss\s*=\s*\$\{this\._handleCommentSuggestionDismiss\}/,
    );
  });

  test('dismiss handler decides the suggestion as not_applicable', () => {
    // The handler turns the click into the canonical "this suggestion
    // can no longer be applied" outcome via decideSuggestion. That's
    // what propagates the dismissal to the SPI / other reviewers.
    // Locate the function definition (not the template @-binding).
    const defStart = multiEditorSrc.indexOf(
      'private _handleCommentSuggestionDismiss',
    );
    expect(defStart).toBeGreaterThan(0);
    const body = multiEditorSrc.slice(defStart, defStart + 800);
    expect(body).toMatch(
      /decideSuggestion\s*\([^)]*['"]not_applicable['"]/,
    );
  });

  test('suggestions list marks orphaned threads (badge or filter)', () => {
    // The pending-suggestions list shouldn't keep advertising
    // applicable counts for orphaned threads. Either filter them out
    // or mark them with a badge so the user sees there's no work to
    // do. Match either approach via the engine's orphan check showing
    // up in the list rendering.
    const listStart = multiEditorSrc.indexOf('_renderSuggestionsList');
    if (listStart < 0) {
      // Fallback: the suggestion list might be rendered by a child
      // component fed an array; just check that the orphan signal
      // reaches the same render path.
      expect(multiEditorSrc).toMatch(/isThreadOrphaned/);
      return;
    }
    const region = multiEditorSrc.slice(listStart, listStart + 1500);
    expect(region).toMatch(/isThreadOrphaned/);
  });
});
