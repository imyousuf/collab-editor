/**
 * @vitest-environment jsdom
 *
 * Integration tests for multi-editor's comments + Suggest Mode wiring.
 * Focuses on the contract surfaces that are easy to verify in isolation:
 *   - Effective flag computation (commentsEnabled + relay + capabilities).
 *   - Feature-gating rule: suggestEnabled is forced off when
 *     commentsEnabled is false.
 *   - comment-thread-activated DOM event opens the panel.
 *   - suggest-submit flow commits a suggestion through the engines.
 *
 * Full end-to-end behavior (Y.Doc sync, binding mount) is exercised in
 * the ATR browser tests; here we isolate the glue code.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { CommentCoordinator } from '../collab/comment-coordinator.js';
import { CommentEngine } from '../collab/comment-engine.js';
import { SuggestEngine } from '../collab/suggest-engine.js';
import type {
  CommentsCapabilities,
  ICommentCapability,
} from '../interfaces/comments.js';
import { Awareness } from 'y-protocols/awareness.js';

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

function bindingDouble(): ICommentCapability & { _calls: any[] } {
  return {
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
}

function setupStack(
  coordConfig: { commentsEnabled?: boolean; suggestEnabled?: boolean } = {},
  capsOverrides: Partial<CommentsCapabilities> = {},
) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ytext.insert(0, 'hello world');
  const awareness = new Awareness(ydoc);
  const engine = new CommentEngine(ydoc, ytext, {
    relayUrl: 'http://relay',
    documentId: 'doc.md',
    user: { userId: 'u1', userName: 'Alice' },
    capabilities: caps(capsOverrides),
    fetchImpl: (async () => new Response('{}', { status: 200 })) as any,
    persistDebounceMs: 10,
    persistEnabled: false,
  });
  // The test uses a minimal collab provider shim. SuggestEngine only
  // touches .replicator and .resetEditorDoc(); everything else is wired by
  // the caller.
  const replicator = { inboundOpen: true, outboundOpen: true } as any;
  const collabShim = {
    replicator,
    resetEditorDoc: () => {},
  } as any;
  const suggest = new SuggestEngine(collabShim, {
    user: { userId: 'u1', userName: 'Alice' },
  });
  const binding = bindingDouble();
  const coord = new CommentCoordinator();
  coord.attach(engine, binding as any, ydoc, awareness, coordConfig);
  return { ydoc, ytext, engine, suggest, binding, coord };
}

describe('Effective feature flags', () => {
  test('commentsEnabled=true + capability.suggestions=true → both available', () => {
    const { coord } = setupStack({ commentsEnabled: true, suggestEnabled: true });
    expect(coord.commentsAvailable).toBe(true);
    expect(coord.suggestAvailable).toBe(true);
  });

  test('commentsEnabled=false → both unavailable (strict dependency)', () => {
    const { coord, binding } = setupStack({
      commentsEnabled: false,
      suggestEnabled: true,
    });
    expect(coord.commentsAvailable).toBe(false);
    expect(coord.suggestAvailable).toBe(false);
    // Binding's enable() must NOT have been called.
    expect(binding._calls.find((c) => c[0] === 'enable')).toBeUndefined();
  });

  test('commentsEnabled=true + suggestEnabled=false → comments only', () => {
    const { coord } = setupStack({
      commentsEnabled: true,
      suggestEnabled: false,
    });
    expect(coord.commentsAvailable).toBe(true);
    expect(coord.suggestAvailable).toBe(false);
  });

  test('capabilities.suggestions=false → comments on, suggest off', () => {
    const { coord } = setupStack(
      { commentsEnabled: true, suggestEnabled: true },
      { suggestions: false },
    );
    expect(coord.commentsAvailable).toBe(true);
    expect(coord.suggestAvailable).toBe(false);
  });
});

describe('Comment creation + panel activation flow', () => {
  test('createThread + setActiveThread pushes thread id to binding', () => {
    const { engine, coord, binding } = setupStack({
      commentsEnabled: true,
    });
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hey', null);
    binding._calls.length = 0;
    coord.setActiveThread(id);
    const push = binding._calls.find((c) => c[0] === 'update');
    expect(push?.[3]).toBe(id);
  });
});

describe('Suggest Mode commit flow', () => {
  test('buildSuggestion via SuggestEngine → CommentEngine creates thread with text-level payload', () => {
    const { engine, suggest } = setupStack({
      commentsEnabled: true,
      suggestEnabled: true,
    });
    suggest.enable('hello world');
    const payload = suggest.buildSuggestion('looks better', 'hello earth');
    const threadId = engine.commitSuggestion(payload);

    const thread = engine.getThreads().find((t) => t.id === threadId);
    expect(thread?.suggestion).toBeDefined();
    expect(thread?.suggestion?.status).toBe('pending');
    expect(thread?.suggestion?.author_note).toBe('looks better');
    // New-model suggestions omit yjs_payload — accept applies a text diff.
    expect(thread?.suggestion?.yjs_payload).toBeUndefined();
    expect(thread?.suggestion?.human_readable.before_text).toBe('world');
    expect(thread?.suggestion?.human_readable.after_text).toBe('earth');
  });
});

describe('Mode switch rewires decorations to new binding', () => {
  test('onModeSwitch enables + updates on the new binding', () => {
    const { coord } = setupStack({ commentsEnabled: true });
    const newBinding = bindingDouble();
    coord.onModeSwitch(newBinding as any);
    expect(newBinding._calls.find((c) => c[0] === 'enable')).toBeDefined();
    expect(newBinding._calls.find((c) => c[0] === 'update')).toBeDefined();
  });
});
