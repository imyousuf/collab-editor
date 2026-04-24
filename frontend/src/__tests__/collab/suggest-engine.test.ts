import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { CollaborationProvider } from '../../collab/collab-provider.js';
import { SuggestEngine } from '../../collab/suggest-engine.js';

function setup(initialContent = 'hello world') {
  const collab = new CollaborationProvider();
  collab.syncText.insert(0, initialContent);
  // Replicator mirrors into editorText automatically.
  const engine = new SuggestEngine(collab, {
    user: { userId: 'u1', userName: 'Alice' },
  });
  return { collab, engine };
}

describe('SuggestEngine — enable/disable', () => {
  test('enable closes outbound gate and records textAtEnable', () => {
    const { collab, engine } = setup('hello world');
    expect(collab.replicator.outboundOpen).toBe(true);
    engine.enable('hello world');
    expect(collab.replicator.outboundOpen).toBe(false);
    expect(engine.getBeforeText()).toBe('hello world');
    expect(engine.isEnabled()).toBe(true);
    collab.destroy();
  });

  test('disable reopens outbound gate', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    engine.disable();
    expect(collab.replicator.outboundOpen).toBe(true);
    expect(engine.isEnabled()).toBe(false);
    collab.destroy();
  });

  test('enable is idempotent', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    engine.enable('other');
    expect(engine.getBeforeText()).toBe('hello world');
    collab.destroy();
  });

  test('hasPendingChanges is false right after enable', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    expect(engine.hasPendingChanges('hello world')).toBe(false);
    collab.destroy();
  });

  test('hasPendingChanges is false when disabled', () => {
    const { collab, engine } = setup();
    expect(engine.hasPendingChanges('anything')).toBe(false);
    collab.destroy();
  });
});

describe('SuggestEngine — outbound gate isolates local drafts', () => {
  test('local edits stay on editorDoc while gate is closed', () => {
    const { collab, engine } = setup('hello world');
    engine.enable('hello world');
    // User types on editorDoc (replicator mirrors to syncDoc when open,
    // blocks when closed).
    collab.editorText.insert(0, 'HI, ');
    expect(collab.editorText.toString()).toBe('HI, hello world');
    expect(collab.syncText.toString()).toBe('hello world');
    expect(engine.hasPendingChanges('HI, hello world')).toBe(true);
    collab.destroy();
  });

  test('peer updates on syncDoc still reach editorDoc while gate is closed', () => {
    const { collab, engine } = setup('hello world');
    engine.enable('hello world');
    // Simulate a peer edit arriving on syncDoc.
    collab.syncText.insert(collab.syncText.length, '!');
    expect(collab.editorText.toString()).toBe('hello world!');
    collab.destroy();
  });
});

describe('SuggestEngine — buildSuggestion (text-level)', () => {
  test('throws when Suggest Mode is off', () => {
    const { collab, engine } = setup();
    expect(() => engine.buildSuggestion(null, 'anything')).toThrow(/not active/);
    collab.destroy();
  });

  test('throws when no pending changes', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    expect(() => engine.buildSuggestion(null, 'hello world')).toThrow(/no pending changes/);
    collab.destroy();
  });

  test('replace: shrinks anchor to minimal changed range', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    const payload = engine.buildSuggestion('size matters', 'hello earth');
    expect(payload.anchor).toEqual({ start: 6, end: 11, quoted_text: 'world' });
    expect(payload.view.before_text).toBe('world');
    expect(payload.view.after_text).toBe('earth');
    expect(payload.view.summary).toContain('Change');
    expect(payload.author_note).toBe('size matters');
    collab.destroy();
  });

  test('insert: anchor has zero-length range', () => {
    const { collab, engine } = setup('abc');
    engine.enable('abc');
    const payload = engine.buildSuggestion(null, 'abcdef');
    expect(payload.anchor.start).toBe(3);
    expect(payload.anchor.end).toBe(3);
    expect(payload.view.operations[0].kind).toBe('insert');
    expect(payload.view.operations[0].inserted_text).toBe('def');
    collab.destroy();
  });

  test('delete: anchor spans removed range', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    const payload = engine.buildSuggestion(null, 'hello');
    expect(payload.anchor).toEqual({ start: 5, end: 11, quoted_text: ' world' });
    expect(payload.view.operations[0].kind).toBe('delete');
    expect(payload.view.after_text).toBe('');
    collab.destroy();
  });

  test('payload does not include yjs_payload (text-level diff only)', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    const payload = engine.buildSuggestion(null, 'hello earth');
    expect(payload.yjs_payload).toBeUndefined();
    collab.destroy();
  });
});

describe('SuggestEngine — commit & discard', () => {
  test('commit builds payload, resets editorDoc, reopens gate', () => {
    const { collab, engine } = setup('hello world');
    const oldEditorDoc = collab.editorDoc;

    engine.enable('hello world');
    // User drafts in editorDoc.
    collab.editorText.insert(0, 'HI, ');
    expect(collab.editorText.toString()).toBe('HI, hello world');
    expect(collab.syncText.toString()).toBe('hello world');

    const payload = engine.commit('my note', 'HI, hello world');

    // Editor doc got swapped — fresh instance, no drafts.
    expect(collab.editorDoc).not.toBe(oldEditorDoc);
    expect(collab.editorText.toString()).toBe('hello world');
    // Gate reopened.
    expect(collab.replicator.outboundOpen).toBe(true);
    expect(engine.isEnabled()).toBe(false);
    // Payload built from the before/after snapshots.
    expect(payload.view.before_text).toBe('');
    expect(payload.view.after_text).toBe('HI, ');

    collab.destroy();
  });

  test('discard resets editorDoc and reopens gate without building payload', () => {
    const { collab, engine } = setup('hello world');
    engine.enable('hello world');
    collab.editorText.insert(0, 'DRAFT ');
    expect(collab.editorText.toString()).toBe('DRAFT hello world');

    engine.discard();

    expect(collab.editorText.toString()).toBe('hello world');
    expect(collab.replicator.outboundOpen).toBe(true);
    expect(engine.isEnabled()).toBe(false);
    collab.destroy();
  });

  test('discard is a no-op when not enabled', () => {
    const { collab, engine } = setup();
    engine.discard();
    expect(engine.isEnabled()).toBe(false);
    collab.destroy();
  });

  test('after commit, further edits propagate to syncDoc normally', () => {
    const { collab, engine } = setup('hello world');
    engine.enable('hello world');
    collab.editorText.insert(0, 'X');
    engine.commit(null, 'Xhello world');
    // After reset + reopen, a fresh edit should replicate without
    // clock-gap issues.
    collab.editorText.insert(collab.editorText.length, '!');
    expect(collab.syncText.toString()).toBe('hello world!');
    collab.destroy();
  });
});

describe('SuggestEngine — destroy', () => {
  test('destroy reopens outbound gate if it was closed', () => {
    const { collab, engine } = setup();
    engine.enable('hello world');
    expect(collab.replicator.outboundOpen).toBe(false);
    engine.destroy();
    expect(collab.replicator.outboundOpen).toBe(true);
    collab.destroy();
  });

  test('destroy is idempotent', () => {
    const { collab, engine } = setup();
    engine.destroy();
    expect(() => engine.destroy()).not.toThrow();
    collab.destroy();
  });
});
