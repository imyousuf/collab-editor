import { describe, test, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness.js';
import { CommentCoordinator } from '../../collab/comment-coordinator.js';
import { CommentEngine } from '../../collab/comment-engine.js';
import type { CommentsCapabilities, ICommentCapability } from '../../interfaces/comments.js';

function caps(overrides: Partial<CommentsCapabilities> = {}): CommentsCapabilities {
  return {
    comment_edit: true,
    comment_delete: true,
    reactions: ['heart'],
    mentions: true,
    suggestions: true,
    max_comment_size: 10240,
    poll_supported: true,
    ...overrides,
  };
}

function makeBinding() {
  const binding: ICommentCapability & { _calls: any[]; destroy?: () => void } = {
    _calls: [],
    enableComments() {
      this._calls.push(['enable']);
    },
    disableComments() {
      this._calls.push(['disable']);
    },
    updateComments(threads, overlays, active) {
      this._calls.push(['update', threads.length, overlays.length, active]);
    },
  };
  return binding;
}

function setup(commentsEnabled = true, suggestEnabled = true) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ytext.insert(0, 'hello world');
  const awareness = new Awareness(ydoc);
  const engine = new CommentEngine(ydoc, ytext, {
    relayUrl: 'http://relay',
    documentId: 'doc.md',
    user: { userId: 'u1', userName: 'Alice' },
    capabilities: caps(),
    fetchImpl: (async () => new Response('{}', { status: 200 })) as any,
    persistDebounceMs: 10,
    persistEnabled: false,
  });
  const binding = makeBinding();
  const coord = new CommentCoordinator();
  coord.attach(engine, binding as any, ydoc, awareness, {
    commentsEnabled,
    suggestEnabled,
  });
  return { coord, engine, binding };
}

describe('CommentCoordinator', () => {
  test('enables binding comments on attach when commentsEnabled is true', () => {
    const { binding } = setup();
    expect(binding._calls[0]).toEqual(['enable']);
    // First push of decorations happens after enable.
    const lastUpdate = binding._calls.find((c) => c[0] === 'update');
    expect(lastUpdate).toBeDefined();
  });

  test('does not enable binding when commentsEnabled is false', () => {
    const { binding, coord } = setup(false);
    expect(binding._calls.find((c) => c[0] === 'enable')).toBeUndefined();
    expect(coord.commentsAvailable).toBe(false);
    expect(coord.commentsActive).toBe(false);
  });

  test('suggestAvailable requires commentsEnabled, suggestEnabled, and capability', () => {
    const { coord: on } = setup(true, true);
    expect(on.suggestAvailable).toBe(true);

    const { coord: suggestOff } = setup(true, false);
    expect(suggestOff.suggestAvailable).toBe(false);

    const { coord: commentsOff } = setup(false, true);
    expect(commentsOff.suggestAvailable).toBe(false);
  });

  test('pushes decorations when thread added', () => {
    const { coord, engine, binding } = setup();
    binding._calls.length = 0;
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    engine.createThread(anchor, startRel, endRel, 'hi', null);
    const update = binding._calls.find((c) => c[0] === 'update');
    expect(update).toBeDefined();
    // threads=1 (the newly-created one); overlays=0 (no suggestion)
    expect(update![1]).toBe(1);
    expect(update![2]).toBe(0);
    expect(coord.commentsActive).toBe(true);
  });

  test('setActiveThread re-pushes with new active id', () => {
    const { coord, engine, binding } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    binding._calls.length = 0;
    coord.setActiveThread(id);
    const update = binding._calls.find((c) => c[0] === 'update');
    expect(update?.[3]).toBe(id);
  });

  test('detach disables binding and clears state', () => {
    const { coord, binding } = setup();
    coord.detach();
    const disable = binding._calls.find((c) => c[0] === 'disable');
    expect(disable).toBeDefined();
    expect(coord.commentsActive).toBe(false);
  });

  test('suggestion overlays include only pending suggestions', () => {
    const { coord, engine } = setup();
    const id = engine.commitSuggestion({
      anchor: { start: 0, end: 5, quoted_text: 'hello' },
      yjs_payload: 'AAA=',
      view: {
        summary: 'change', before_text: 'hello', after_text: 'HELLO', operations: [],
      },
      author_note: null,
    });
    expect(coord.getSuggestionOverlays()).toHaveLength(1);
    engine.decideSuggestion(id, 'accepted');
    expect(coord.getSuggestionOverlays()).toHaveLength(0);
  });

  test('defaultColor is deterministic per user id', () => {
    const c1 = CommentCoordinator.defaultColor('alice');
    const c2 = CommentCoordinator.defaultColor('alice');
    const c3 = CommentCoordinator.defaultColor('bob');
    expect(c1).toBe(c2);
    expect(c1).not.toBe(c3);
  });

  test('onModeSwitch re-enables comments on the new binding', () => {
    const { coord } = setup();
    const newBinding = makeBinding();
    coord.onModeSwitch(newBinding as any);
    expect(newBinding._calls.find((c) => c[0] === 'enable')).toBeDefined();
    // Subsequent thread activity pushes to the new binding.
    expect(newBinding._calls.find((c) => c[0] === 'update')).toBeDefined();
  });
});
