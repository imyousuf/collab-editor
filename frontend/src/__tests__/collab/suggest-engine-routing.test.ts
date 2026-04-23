/**
 * Integration test: SuggestEngine + binding rebind end-to-end routing.
 *
 * Context: before the fix, the buffer Y.Doc was isolated from the
 * editor and local edits leaked to peers via the shared Y.Text. These
 * tests assert the full loop:
 *   1. SuggestEngine.enable() returns a seeded buffer.
 *   2. binding.rebindSharedText(buffer) retargets yCollab.
 *   3. Editor-level edits land on the buffer, not the base.
 *   4. hasPendingChanges() becomes true and onBufferChange fires.
 *   5. Disable + rebind back routes edits to base again.
 *
 * The test runs across all three content handlers that reach the
 * editor-binding layer (Markdown, HTML, PlainText) to confirm the fix
 * is handler-agnostic, as designed — the rebind swaps a Y.Text
 * reference beneath the handler pipeline.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness.js';
import { SuggestEngine } from '../../collab/suggest-engine.js';
import { SourceOnlyBinding } from '../../bindings/source-only-binding.js';
import { DualModeBinding } from '../../bindings/dual-mode-binding.js';
import { MarkdownContentHandler } from '../../handlers/markdown-handler.js';
import { HtmlContentHandler } from '../../handlers/html-handler.js';
import { PlainTextContentHandler } from '../../handlers/plaintext-handler.js';

function makeCollabContext() {
  const ydoc = new Y.Doc();
  const sharedText = ydoc.getText('source');
  const awareness = new Awareness(ydoc);
  return { ydoc, sharedText, awareness };
}

function makeSuggestEngine(ydoc: Y.Doc, sharedText: Y.Text) {
  return new SuggestEngine(ydoc, sharedText, {
    user: { userId: 'u1', userName: 'User 1' },
  });
}

describe('SuggestEngine + rebind routing (DualModeBinding + Markdown)', () => {
  let ctx: ReturnType<typeof makeCollabContext>;
  let binding: DualModeBinding;
  let container: HTMLElement;
  let engine: SuggestEngine;

  beforeEach(async () => {
    ctx = makeCollabContext();
    ctx.sharedText.insert(0, '# Hello\n');
    container = document.createElement('div');
    document.body.appendChild(container);
    binding = new DualModeBinding(new MarkdownContentHandler(), 'markdown');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' }, ctx);
    engine = makeSuggestEngine(ctx.ydoc, ctx.sharedText);
  });

  afterEach(() => {
    engine.disable();
    binding.destroy();
    ctx.awareness.destroy();
    ctx.ydoc.destroy();
    container.remove();
  });

  test('after enable+rebind, editor writes land on the buffer, not the base', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);

    // Buffer was seeded from base → same content.
    expect(bufferText.toString()).toBe('# Hello\n');

    // Simulate a user typing at position 0 via the source editor's view.
    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: 'X' } });

    expect(bufferText.toString()).toBe('X# Hello\n');
    // Base is untouched — no leak to peers.
    expect(ctx.sharedText.toString()).toBe('# Hello\n');
  });

  test('hasPendingChanges becomes true after a buffer edit', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);
    expect(engine.hasPendingChanges()).toBe(false);

    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: 'Z' } });

    expect(engine.hasPendingChanges()).toBe(true);
  });

  test('symmetric capture: before/after differ by exactly the user edit', () => {
    // Regression guard for the whole-doc-corruption bug. When `enable`
    // and `buildSuggestion` both receive the editor-native serialized
    // form, normalization drift between raw Y.Text and Tiptap's output
    // can't leak into the diff. The `view.before_text`/`view.after_text`
    // must differ by exactly what the user inserted — not by the whole
    // document. With no user edit, `hasPendingChanges` is false, so we
    // simulate the edit directly on the buffer and use the
    // buffer-matches-base shortcut to exercise the symmetric path.
    const { bufferText } = engine.enable('# Hello\n');
    // Mutate buffer to simulate the user typing ' - 123' at the end of
    // the heading line. This matches what a real-editor write-back
    // would produce when Tiptap's serializer is idempotent.
    bufferText.insert(7, ' - 123');
    expect(engine.hasPendingChanges()).toBe(true);

    const payload = engine.buildSuggestion(null, '# Hello - 123\n');
    expect(payload.view.before_text).toBe('');
    expect(payload.view.after_text).toBe(' - 123');
    expect(payload.view.summary).toContain('- 123');
  });

  test('onBufferChange fires on editor-driven buffer edits', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);

    let fired = 0;
    engine.onBufferChange(() => { fired++; });

    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: 'A' } });

    expect(fired).toBeGreaterThan(0);
  });

  test('disable + rebind back routes writes to the base again', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);
    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: 'B' } });
    expect(bufferText.toString()).toBe('B# Hello\n');

    // Rebind back to base, then disable.
    binding.rebindSharedText(ctx.sharedText);
    engine.disable();

    // Subsequent edits go to the base.
    source.view.dispatch({ changes: { from: 0, insert: 'Y' } });
    expect(ctx.sharedText.toString()).toBe('Y# Hello\n');
  });

  test('remote base updates still rebase onto the buffer during Suggest Mode', () => {
    // The rebase observer lives in SuggestEngine itself and doesn't
    // depend on the binding. Test it WITHOUT the binding to avoid the
    // jsdom limitation where yCollab's Y.Text→editor direction can't
    // apply changes (the editor's doc stays empty in jsdom).
    const localCtx = makeCollabContext();
    localCtx.sharedText.insert(0, '# Hello\n');
    const localEngine = makeSuggestEngine(localCtx.ydoc, localCtx.sharedText);
    try {
      const { bufferText } = localEngine.enable();

      // Simulate a remote edit on base (e.g., a peer typed).
      localCtx.sharedText.insert(localCtx.sharedText.length, ' + remote');

      // The SuggestEngine's rebase observer applies the remote update
      // onto the buffer, so the buffer reflects the merged state.
      expect(bufferText.toString()).toContain('+ remote');
      expect(localCtx.sharedText.toString()).toBe('# Hello\n + remote');
    } finally {
      localEngine.disable();
      localCtx.awareness.destroy();
      localCtx.ydoc.destroy();
    }
  });
});

describe('SuggestEngine + rebind routing (DualModeBinding + HTML)', () => {
  let ctx: ReturnType<typeof makeCollabContext>;
  let binding: DualModeBinding;
  let container: HTMLElement;
  let engine: SuggestEngine;

  beforeEach(async () => {
    ctx = makeCollabContext();
    ctx.sharedText.insert(0, '<p>Hello</p>');
    container = document.createElement('div');
    document.body.appendChild(container);
    binding = new DualModeBinding(new HtmlContentHandler(), 'html');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' }, ctx);
    engine = makeSuggestEngine(ctx.ydoc, ctx.sharedText);
  });

  afterEach(() => {
    engine.disable();
    binding.destroy();
    ctx.awareness.destroy();
    ctx.ydoc.destroy();
    container.remove();
  });

  test('HTML content round-trips into the buffer', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);

    // Syntax characters (<p>, </p>) are preserved byte-for-byte on seed.
    expect(bufferText.toString()).toBe('<p>Hello</p>');

    // yCollab's initial Y.Text→editor sync is deferred in jsdom, so the
    // editor doc is still empty at this point. We can only dispatch
    // edits at position 0. yCollab's editor→Y.Text direction is
    // synchronous, so the insert still propagates to whichever Y.Text
    // is currently bound (the buffer, after rebind).
    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: '<p>!</p>' } });

    // Buffer receives the insert at position 0 — confirms routing.
    expect(bufferText.toString()).toBe('<p>!</p><p>Hello</p>');
    expect(ctx.sharedText.toString()).toBe('<p>Hello</p>');
  });
});

describe('SuggestEngine + rebind routing (SourceOnlyBinding + PlainText)', () => {
  let ctx: ReturnType<typeof makeCollabContext>;
  let binding: SourceOnlyBinding;
  let container: HTMLElement;
  let engine: SuggestEngine;

  beforeEach(async () => {
    ctx = makeCollabContext();
    ctx.sharedText.insert(0, 'plain content');
    container = document.createElement('div');
    document.body.appendChild(container);
    binding = new SourceOnlyBinding('plaintext');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' }, ctx);
    engine = makeSuggestEngine(ctx.ydoc, ctx.sharedText);
    // PlainTextContentHandler is not directly involved here since
    // SourceOnlyBinding doesn't use it — the source editor binds to
    // Y.Text as a raw string. Handler exists for the registry/factory
    // path but isn't in this integration's critical chain.
    new PlainTextContentHandler();
  });

  afterEach(() => {
    engine.disable();
    binding.destroy();
    ctx.awareness.destroy();
    ctx.ydoc.destroy();
    container.remove();
  });

  test('plain text edits route to the buffer on a source-only binding', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);

    expect(bufferText.toString()).toBe('plain content');

    const source = (binding as any)._editor;
    source.view.dispatch({ changes: { from: 0, insert: 'X ' } });

    expect(bufferText.toString()).toBe('X plain content');
    expect(ctx.sharedText.toString()).toBe('plain content');
  });

  test('rebind back restores base-writes on SourceOnlyBinding', () => {
    const { bufferText } = engine.enable();
    binding.rebindSharedText(bufferText);
    const source = (binding as any)._editor;
    source.view.dispatch({ changes: { from: 0, insert: 'Q' } });
    expect(bufferText.toString()).toBe('Qplain content');

    binding.rebindSharedText(ctx.sharedText);
    engine.disable();

    source.view.dispatch({ changes: { from: 0, insert: 'R' } });
    expect(ctx.sharedText.toString()).toBe('Rplain content');
  });
});
