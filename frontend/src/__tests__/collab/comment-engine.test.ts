import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import { CommentEngine, extractMentions } from '../../collab/comment-engine.js';
import type { CommentsCapabilities } from '../../interfaces/comments.js';

function caps(overrides: Partial<CommentsCapabilities> = {}): CommentsCapabilities {
  return {
    comment_edit: true,
    comment_delete: true,
    reactions: ['thumbsup', 'heart'],
    mentions: true,
    suggestions: true,
    max_comment_size: 10240,
    poll_supported: true,
    ...overrides,
  };
}

function setup(capabilities: CommentsCapabilities = caps()) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ytext.insert(0, 'hello world');

  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
    return new Response('{}', { status: 200 });
  });
  const engine = new CommentEngine(ydoc, ytext, {
    relayUrl: 'http://relay',
    documentId: 'doc.md',
    user: { userId: 'u1', userName: 'Alice' },
    capabilities,
    fetchImpl: fetchMock as any,
    persistDebounceMs: 10,
  });
  return { ydoc, ytext, engine, fetchMock };
}

describe('CommentEngine — anchors', () => {
  test('createAnchor captures offsets and quoted text', () => {
    const { engine } = setup();
    const { anchor } = engine.createAnchor(0, 5);
    expect(anchor).toEqual({ start: 0, end: 5, quoted_text: 'hello' });
  });

  test('anchor survives insertion before the range', () => {
    const { engine, ytext } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(6, 11); // "world"

    // Insert text before the anchor range.
    ytext.insert(0, 'OH, ');

    // resolveAnchor uses the raw StoredThread shape; build a minimal one.
    const stored = {
      anchor,
      start_rel: u8ToBase64(startRel),
      end_rel: u8ToBase64(endRel),
      status: 'open' as const,
      comments: [],
      createdAt: new Date().toISOString(),
    };
    const resolved = (engine as any).resolveAnchor(stored);
    expect(resolved).not.toBeNull();
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('world');
  });

  test('fuzzy fallback when relative anchors missing', () => {
    const { engine } = setup();
    const stored = {
      anchor: { start: 999, end: 1000, quoted_text: 'world' },
      status: 'open' as const,
      comments: [],
      createdAt: new Date().toISOString(),
    };
    const resolved = (engine as any).resolveAnchor(stored);
    expect(resolved).toEqual({ from: 6, to: 11 });
  });

  test('returns null when quoted text no longer exists', () => {
    const { engine, ytext } = setup();
    ytext.delete(0, ytext.length);
    ytext.insert(0, 'different');

    const stored = {
      anchor: { start: 0, end: 5, quoted_text: 'never-there' },
      status: 'open' as const,
      comments: [],
      createdAt: new Date().toISOString(),
    };
    const resolved = (engine as any).resolveAnchor(stored);
    expect(resolved).toBeNull();
  });

  test('resolveAnchorById resolves a live thread', () => {
    const { engine, ytext } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(6, 11); // "world"
    const id = engine.createThread(anchor, startRel, endRel, 'hey', null);

    // Peer-like edit: insert before the anchor.
    ytext.insert(0, 'OH, ');

    const resolved = engine.resolveAnchorById(id);
    expect(resolved).not.toBeNull();
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('world');
  });

  test('resolveAnchorById returns null for an unknown id', () => {
    const { engine } = setup();
    expect(engine.resolveAnchorById('does-not-exist')).toBeNull();
  });
});

describe('CommentEngine — CRUD writes to Y.Map', () => {
  test('createThread inserts into Y.Map and fires listener', () => {
    const { ydoc, engine } = setup();
    const listener = vi.fn();
    engine.onThreadsChange(listener);

    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi!', null);

    const ymap = ydoc.getMap('comments');
    expect(ymap.has(id)).toBe(true);
    expect(listener).toHaveBeenCalled();
    const snapshot = listener.mock.calls.at(-1)![0];
    expect(snapshot[0].comments[0].content).toBe('hi!');
  });

  test('addReply appends comment to existing thread', () => {
    const { engine } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);

    const reply = engine.addReply(id, 'reply');
    expect(reply?.content).toBe('reply');
    const thread = engine.getThreads().find((t) => t.id === id);
    expect(thread?.comments).toHaveLength(2);
  });

  test('resolveThread/reopenThread toggles status', () => {
    const { engine } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    engine.resolveThread(id);
    expect(engine.getThreads()[0].status).toBe('resolved');
    engine.reopenThread(id);
    expect(engine.getThreads()[0].status).toBe('open');
  });

  test('deleteThread removes from Y.Map', () => {
    const { engine, ydoc } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    engine.deleteThread(id);
    expect(ydoc.getMap('comments').has(id)).toBe(false);
  });
});

describe('CommentEngine — feature gating', () => {
  test('editComment is no-op when capability off', () => {
    const { engine } = setup(caps({ comment_edit: false }));
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    const commentId = engine.getThreads()[0].comments[0].id;
    engine.editComment(id, commentId, 'edited');
    expect(engine.getThreads()[0].comments[0].content).toBe('hi');
  });

  test('addReaction rejects unknown emoji', () => {
    const { engine } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    engine.addReaction(id, null, 'not-allowed');
    expect(engine.getThreads()[0].reactions ?? []).toHaveLength(0);
  });

  test('addReaction is idempotent per (user, emoji)', () => {
    const { engine } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    engine.addReaction(id, null, 'heart');
    engine.addReaction(id, null, 'heart');
    expect(engine.getThreads()[0].reactions ?? []).toHaveLength(1);
    engine.removeReaction(id, null, 'heart');
    expect(engine.getThreads()[0].reactions ?? []).toHaveLength(0);
  });

  test('enforces max_comment_size', () => {
    const { engine } = setup(caps({ max_comment_size: 10 }));
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    expect(() =>
      engine.createThread(anchor, startRel, endRel, 'a'.repeat(11), null),
    ).toThrow(/exceeds max size/);
  });
});

describe('CommentEngine — suggestions', () => {
  test('commitSuggestion creates thread with opaque yjs_payload', () => {
    const { engine } = setup();
    const id = engine.commitSuggestion({
      anchor: { start: 0, end: 5, quoted_text: 'hello' },
      yjs_payload: 'AQEB',
      view: {
        summary: 'Change "hello" to "hi"',
        before_text: 'hello',
        after_text: 'hi',
        operations: [],
      },
      author_note: 'optional note',
    });
    const thread = engine.getThreads().find((t) => t.id === id)!;
    expect(thread.suggestion?.yjs_payload).toBe('AQEB');
    expect(thread.suggestion?.status).toBe('pending');
  });

  test('decideSuggestion marks thread resolved and records decision', () => {
    const { engine } = setup();
    const id = engine.commitSuggestion({
      anchor: { start: 0, end: 5, quoted_text: 'hello' },
      yjs_payload: 'AAA=',
      view: { summary: 's', before_text: 'hello', after_text: 'HELLO', operations: [] },
      author_note: null,
    });
    engine.decideSuggestion(id, 'accepted', 'v42');
    const t = engine.getThreads().find((x) => x.id === id)!;
    expect(t.status).toBe('resolved');
    expect(t.suggestion?.status).toBe('accepted');
    expect(t.suggestion?.applied_version_id).toBe('v42');
  });
});

describe('CommentEngine — persistence', () => {
  test('debounced POST on create', async () => {
    const { engine, fetchMock } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow();

    const createCall = fetchMock.mock.calls.find(
      (c) => typeof c[1]?.method === 'string' && c[1]!.method === 'POST',
    );
    expect(createCall).toBeDefined();
    expect(createCall?.[0]).toContain('/api/documents/comments');
    expect(createCall?.[0]).toContain('path=doc.md');
  });

  test('PATCH on status change when thread was previously persisted', async () => {
    const { engine, fetchMock } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow();
    fetchMock.mockClear();

    engine.resolveThread(id);
    await engine.flushNow();

    const patch = fetchMock.mock.calls.find(
      (c) => typeof c[1]?.method === 'string' && c[1]!.method === 'PATCH',
    );
    expect(patch).toBeDefined();
    expect(patch?.[0]).toContain(`/api/documents/comments/${id}`);
  });

  test('DELETE on thread deletion', async () => {
    const { engine, fetchMock } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow();
    fetchMock.mockClear();

    engine.deleteThread(id);
    await engine.flushNow();

    const del = fetchMock.mock.calls.find(
      (c) => typeof c[1]?.method === 'string' && c[1]!.method === 'DELETE',
    );
    expect(del).toBeDefined();
  });

  test('POST body carries the client thread id + initial comment id', async () => {
    // Regression: the provider used to generate its own UUID, so the
    // Y.Map key (frontend-authoritative) never matched what was on disk.
    // Resolve PATCHes then hit 404 and the thread diverged. Client IDs
    // must ride the create payload.
    const { engine, fetchMock } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const tid = engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow();

    const post = fetchMock.mock.calls.find(
      (c) => c[1]?.method === 'POST' && /\/comments\?path=/.test(c[0] as string),
    );
    expect(post).toBeDefined();
    const body = JSON.parse(post![1]!.body as string);
    expect(body.id).toBe(tid);
    expect(body.comment.id).toBeDefined();
    expect(typeof body.comment.id).toBe('string');

    // The comment id in the wire body must match what's in the Y.Map,
    // otherwise the Y.Map and server-side comments diverge after a
    // subsequent GET replaces the Y.Map entry with server state.
    const local = engine.getThreads().find((t) => t.id === tid)!;
    expect(body.comment.id).toBe(local.comments[0].id);
  });

  test('409 conflict on create is treated as success (another peer beat us)', async () => {
    // Multi-tab scenario: tab A creates thread T and POSTs, tab B
    // receives T via Y-sync and also tries to POST. The second POST
    // returns 409. The second client should NOT retry forever — the
    // thread is already persisted under the same id.
    const { engine, fetchMock } = setup();
    fetchMock.mockImplementationOnce(
      async () => new Response('conflict', { status: 409 }),
    );
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow();

    // Would have re-queued on 500 and retried; must NOT on 409.
    const posts = fetchMock.mock.calls.filter(
      (c) => c[1]?.method === 'POST',
    );
    expect(posts.length).toBe(1);
  });

  test('reply POST body carries the client comment id', async () => {
    const { engine, fetchMock } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const tid = engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow();
    fetchMock.mockClear();

    engine.addReply(tid, 'follow-up');
    await engine.flushNow();

    const replyPost = fetchMock.mock.calls.find(
      (c) => c[1]?.method === 'POST' && /\/replies\?path=/.test(c[0] as string),
    );
    expect(replyPost).toBeDefined();
    const body = JSON.parse(replyPost![1]!.body as string);
    expect(body.id).toBeDefined();
    const reply = engine.getThreads().find((t) => t.id === tid)!.comments[1];
    expect(body.id).toBe(reply.id);
  });

  test('failed POST is re-queued so the next flush retries it', async () => {
    const { engine, fetchMock } = setup();
    // First attempt: 500. Second attempt: 201.
    fetchMock
      .mockImplementationOnce(async () => new Response('boom', { status: 500 }))
      .mockImplementationOnce(async () => new Response('{}', { status: 201 }));
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    engine.createThread(anchor, startRel, endRel, 'hi', null);
    await engine.flushNow(); // first attempt fails
    await engine.flushNow(); // retry picks up the re-queued id

    const posts = fetchMock.mock.calls.filter(
      (c) => typeof c[1]?.method === 'string' && c[1]!.method === 'POST',
    );
    expect(posts.length).toBe(2);
  });
});

describe('CommentEngine — mentions', () => {
  test('extractMentions parses @[Display](user-id) tokens', () => {
    const mentions = extractMentions('hey @[Alice](u1) and @[Bob](u2)');
    expect(mentions).toEqual([
      { user_id: 'u1', display_name: 'Alice' },
      { user_id: 'u2', display_name: 'Bob' },
    ]);
  });

  test('createThread populates mentions from content', () => {
    const { engine } = setup();
    const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
    const id = engine.createThread(
      anchor, startRel, endRel,
      'cc @[Bob](u2)',
      null,
    );
    const t = engine.getThreads().find((x) => x.id === id)!;
    expect(t.comments[0].mentions).toEqual([{ user_id: 'u2', display_name: 'Bob' }]);
  });

  test('searchMentions returns empty when capability disabled', async () => {
    const { engine } = setup(caps({ mentions: false }));
    const results = await engine.searchMentions('ali');
    expect(results).toEqual([]);
  });

  test('searchMentions proxies through relay', async () => {
    const { engine, fetchMock } = setup();
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ candidates: [{ user_id: 'u2', display_name: 'Bob' }] }),
        { status: 200 },
      ),
    );
    const candidates = await engine.searchMentions('bo', 5);
    expect(candidates[0].user_id).toBe('u2');
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/api/documents/comments/mentions/search',
    );
    expect(fetchMock.mock.calls[0][0]).toContain('q=bo');
  });
});

describe('CommentEngine — polling', () => {
  test('pollOnce processes deletions without new fetches', async () => {
    // Stub focus so the focus-gate doesn't skip the poll in jsdom.
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => true;
    try {
      const { engine, ydoc, fetchMock } = setup();
      // Pre-populate Y.Map.
      const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
      const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
      await engine.flushNow();

      fetchMock.mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            changes: [{ thread_id: id, action: 'deleted', by: 'other', at: '' }],
            server_time: '2026-01-01T00:00:00Z',
          }),
          { status: 200 },
        ),
      );
      await engine.pollOnce();
      expect(ydoc.getMap('comments').has(id)).toBe(false);
    } finally {
      document.hasFocus = originalHasFocus;
    }
  });

  test('pollOnce skips entirely when document is out of focus', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      const { engine, fetchMock } = setup();
      fetchMock.mockClear();
      const changes = await engine.pollOnce();
      expect(changes).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      document.hasFocus = originalHasFocus;
    }
  });

  test('pollOnce applies external PATCH by refetching and updating Y.Map', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => true;
    try {
      const { engine, fetchMock, ydoc } = setup();
      // Pre-populate a thread that was already open.
      const { anchor, startRel, endRel } = engine.createAnchor(0, 5);
      const id = engine.createThread(anchor, startRel, endRel, 'hi', null);
      await engine.flushNow();
      fetchMock.mockClear();

      // First call: the poll response. Second call: GET thread detail.
      fetchMock
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              changes: [
                { thread_id: id, action: 'resolved', by: 'other', at: '2026-01-02T00:00:00Z' },
              ],
              server_time: '2026-01-02T00:00:01Z',
            }),
            { status: 200 },
          ),
        )
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              id,
              document_id: 'doc.md',
              anchor: { start: 0, end: 5, quoted_text: 'hello' },
              status: 'resolved',
              created_at: '2026-01-01T00:00:00Z',
              resolved_at: '2026-01-02T00:00:00Z',
              resolved_by: 'other',
              comments: [],
            }),
            { status: 200 },
          ),
        );

      await engine.pollOnce();

      const raw = ydoc.getMap('comments').get(id) as any;
      expect(raw?.status).toBe('resolved');
      expect(raw?.resolvedBy).toBe('other');
    } finally {
      document.hasFocus = originalHasFocus;
    }
  });

  test('pollOnce reconciliation does not feed back to the persistence loop', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => true;
    try {
      const { engine, fetchMock, ydoc } = setup();
      fetchMock.mockClear();

      // External "create" event arriving via poll.
      const id = 'external-thread-id';
      fetchMock
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              changes: [
                { thread_id: id, action: 'created', by: 'other', at: '2026-01-02T00:00:00Z' },
              ],
              server_time: '2026-01-02T00:00:01Z',
            }),
            { status: 200 },
          ),
        )
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              id,
              document_id: 'doc.md',
              anchor: { start: 0, end: 5, quoted_text: 'hello' },
              status: 'open',
              created_at: '2026-01-02T00:00:00Z',
              comments: [],
            }),
            { status: 200 },
          ),
        );
      await engine.pollOnce();
      fetchMock.mockClear();

      // No outstanding dirty work — persistence loop should not POST
      // (that would echo the poll result back to the server).
      await engine.flushNow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ydoc.getMap('comments').has(id)).toBe(true);
    } finally {
      document.hasFocus = originalHasFocus;
    }
  });
});

// --- helpers ---

function u8ToBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
