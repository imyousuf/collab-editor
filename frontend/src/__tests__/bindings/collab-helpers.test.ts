import { describe, test, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { setCollabContent, observeRemoteChanges } from '../../bindings/collab-helpers.js';
import type { CollaborationContext, RemoteChangeCallback } from '../../interfaces/editor-binding.js';

function createCollabContext(): { context: CollaborationContext; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  const context: CollaborationContext = {
    sharedText: ydoc.getText('source'),
    awareness: null,
    ydoc,
  };
  return { context, ydoc };
}

describe('setCollabContent', () => {
  test('returns true and inserts when Y.Text is empty', () => {
    const { context, ydoc } = createCollabContext();
    const result = setCollabContent(context, 'hello world');
    expect(result).toBe(true);
    expect(context.sharedText.toString()).toBe('hello world');
    ydoc.destroy();
  });

  test('returns false and does not overwrite when Y.Text has content', () => {
    const { context, ydoc } = createCollabContext();
    context.sharedText.insert(0, 'existing');
    const result = setCollabContent(context, 'new content');
    expect(result).toBe(false);
    expect(context.sharedText.toString()).toBe('existing');
    ydoc.destroy();
  });

  test('is idempotent — second call with same text returns false', () => {
    const { context, ydoc } = createCollabContext();
    expect(setCollabContent(context, 'hello')).toBe(true);
    expect(setCollabContent(context, 'hello')).toBe(false);
    expect(context.sharedText.toString()).toBe('hello');
    ydoc.destroy();
  });

  test('handles empty string insertion', () => {
    const { context, ydoc } = createCollabContext();
    // Empty string insert — Y.Text length stays 0
    const result = setCollabContent(context, '');
    expect(result).toBe(true);
    expect(context.sharedText.toString()).toBe('');
    ydoc.destroy();
  });

  test('handles multiline content', () => {
    const { context, ydoc } = createCollabContext();
    const multiline = '# Title\n\nParagraph 1\n\n## Section\n\nParagraph 2';
    setCollabContent(context, multiline);
    expect(context.sharedText.toString()).toBe(multiline);
    ydoc.destroy();
  });

  test('handles HTML content with tags', () => {
    const { context, ydoc } = createCollabContext();
    const html = '<h1>Title</h1><p>This is <strong>bold</strong> and <em>italic</em>.</p>';
    setCollabContent(context, html);
    expect(context.sharedText.toString()).toBe(html);
    ydoc.destroy();
  });
});

describe('observeRemoteChanges', () => {
  test('fires callbacks for remote (non-local) Y.Text changes', () => {
    const { context, ydoc } = createCollabContext();
    const callbacks = new Set<RemoteChangeCallback>();
    const handler = vi.fn();
    callbacks.add(handler);

    observeRemoteChanges(context, callbacks);

    // Simulate a remote change by applying an update from a second Y.Doc
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText('source');
    remoteText.insert(0, 'remote text');
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(ydoc, update);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].isRemote).toBe(true);

    remoteDoc.destroy();
    ydoc.destroy();
  });

  test('does NOT fire callbacks for local Y.Text changes', () => {
    const { context, ydoc } = createCollabContext();
    const callbacks = new Set<RemoteChangeCallback>();
    const handler = vi.fn();
    callbacks.add(handler);

    observeRemoteChanges(context, callbacks);

    // Local change (no origin or local origin)
    context.sharedText.insert(0, 'local text');

    expect(handler).not.toHaveBeenCalled();

    ydoc.destroy();
  });

  test('fires all registered callbacks', () => {
    const { context, ydoc } = createCollabContext();
    const callbacks = new Set<RemoteChangeCallback>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    callbacks.add(handler1);
    callbacks.add(handler2);

    observeRemoteChanges(context, callbacks);

    // Simulate remote change via second Y.Doc
    const remoteDoc = new Y.Doc();
    remoteDoc.getText('source').insert(0, 'data');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);

    remoteDoc.destroy();
    ydoc.destroy();
  });

  test('respects callback removal from set', () => {
    const { context, ydoc } = createCollabContext();
    const callbacks = new Set<RemoteChangeCallback>();
    const handler = vi.fn();
    callbacks.add(handler);

    observeRemoteChanges(context, callbacks);

    // Remove handler before triggering change
    callbacks.delete(handler);

    const remoteOrigin = Symbol('remote');
    ydoc.transact(() => {
      context.sharedText.insert(0, 'data');
    }, remoteOrigin);

    expect(handler).not.toHaveBeenCalled();

    ydoc.destroy();
  });
});
