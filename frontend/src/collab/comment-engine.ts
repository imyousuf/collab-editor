/**
 * CommentEngine — client-side coordinator for the Comments SPI.
 *
 * Responsibilities:
 *   - Owns `Y.Map("comments")` on the existing Y.Doc (the canonical,
 *     real-time-synced store for comment threads + committed suggestions).
 *   - Converts between Y.RelativePosition anchors (for robust in-editor
 *     anchoring) and `{start, end, quoted_text}` offsets (for the SPI).
 *   - Debounced persistence to the Comments Provider via the relay proxy
 *     (/api/documents/comments/*).
 *   - Capabilities discovery on connect; feature gating on writes.
 *   - Mentions search helper (debounced).
 *   - Polling for external changes (focus-gated, per-document).
 *
 * This engine is Yjs-aware internally. Suggestion `yjs_payload` passes
 * through to the SPI as an opaque base64 string — the engine never
 * decodes it on write; decoding happens only on Accept, in the
 * coordinator/multi-editor layer.
 */

import * as Y from 'yjs';
import { dlog } from './debug-log.js';
import type {
  Comment,
  CommentAnchor,
  CommentThread,
  CommentThreadListEntry,
  CommentsCapabilities,
  MentionCandidate,
  Mention,
  Reaction,
  Suggestion,
  SuggestionOverlayRegion,
  SuggestionStatus,
  CommentChange,
} from '../interfaces/comments.js';
import type { SuggestionPayload } from '../interfaces/suggest.js';

/** Fetch implementation — overridable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CommentEngineConfig {
  relayUrl: string;
  documentId: string;
  user: { userId: string; userName: string; userColor?: string };
  /** Overrideable fetch wrapper — default is globalThis.fetch with credentials. */
  fetchImpl?: FetchLike;
  /** Capabilities already fetched by the coordinator (skips a round-trip on load). */
  capabilities?: CommentsCapabilities;
  /** Polling interval in ms. Default 30000. Set to 0 to disable polling. */
  pollIntervalMs?: number;
  /** Debounce in ms for the SPI persistence loop. Default 2000. */
  persistDebounceMs?: number;
  /**
   * When true, treat Y.Map changes originating from this client as dirty
   * for persistence. Default: true. Tests set false to isolate the
   * persistence logic from Y.Doc observers.
   */
  persistEnabled?: boolean;
}

/** Origin tag for Y.Map mutations driven by external polling reconciliation. */
const POLL_ORIGIN = Symbol('comment-engine-poll');

/** Shape of a stored thread inside Y.Map("comments"). */
interface StoredThread {
  /** Character-offset anchor at write time (redundant with relatives but handy). */
  anchor: CommentAnchor;
  /** Base64 Uint8Array-encoded Y.RelativePosition for the start. */
  start_rel?: string;
  end_rel?: string;
  status: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedAt?: string;
  suggestion?: Suggestion;
  comments: Comment[];
  reactions?: Reaction[];
  createdAt: string;
}

export class CommentEngine {
  private readonly _ydoc: Y.Doc;
  private readonly _ytext: Y.Text;
  private readonly _ymap: Y.Map<any>;
  private readonly _config: Required<Omit<CommentEngineConfig, 'capabilities' | 'user'>> & {
    user: CommentEngineConfig['user'];
    capabilities: CommentsCapabilities | null;
  };

  private readonly _listeners = new Set<(threads: CommentThread[]) => void>();
  private readonly _dirty = new Set<string>();
  private readonly _lastPersisted = new Map<string, string>(); // threadId -> JSON snapshot
  /** per-key retry counter; cap prevents infinite loops on 4xx. */
  private readonly _retryCount = new Map<string, number>();
  private static readonly MAX_PERSIST_RETRIES = 5;

  private _capabilities: CommentsCapabilities | null;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _lastPollAt: string | null = null;

  constructor(ydoc: Y.Doc, ytext: Y.Text, config: CommentEngineConfig) {
    this._ydoc = ydoc;
    this._ytext = ytext;
    this._ymap = ydoc.getMap<any>('comments');
    this._capabilities = config.capabilities ?? null;

    this._config = {
      relayUrl: config.relayUrl,
      documentId: config.documentId,
      user: config.user,
      fetchImpl:
        config.fetchImpl ??
        ((input, init) =>
          (globalThis as any).fetch(input, {
            credentials: 'include',
            ...init,
          })),
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
      persistDebounceMs: config.persistDebounceMs ?? 2000,
      persistEnabled: config.persistEnabled ?? true,
      capabilities: this._capabilities,
    };

    // Observe Y.Map mutations to notify listeners + mark dirty threads.
    //
    // POLL_ORIGIN events MUST NOT mark keys dirty or schedule persist —
    // that would echo the server's state right back at it. But they
    // still need to fire UI listeners so panels driven by
    // onThreadsChange (resolved list, pending suggestions, status-bar
    // counts) reflect freshly-loaded server state. Splitting the two
    // flags keeps both invariants.
    this._ymap.observeDeep((events) => {
      let anyChange = false;
      let userOriginatedChange = false;
      for (const e of events) {
        anyChange = true;
        if (e.transaction.origin === POLL_ORIGIN) continue;
        userOriginatedChange = true;
        // Top-level map changes mark the added/updated keys dirty.
        if ((e.target as any) === this._ymap) {
          for (const k of e.keys.keys()) this._dirty.add(k);
        } else {
          // Nested change inside one of the sub-maps: walk up to the thread id.
          const threadId = findThreadId(e.target, this._ymap);
          if (threadId) this._dirty.add(threadId);
        }
      }
      if (anyChange) this._notifyListeners();
      if (userOriginatedChange && this._config.persistEnabled) this._schedulePersist();
    });
  }

  // --- Public: capabilities ---

  capabilities(): CommentsCapabilities | null {
    return this._capabilities;
  }

  async fetchCapabilities(): Promise<CommentsCapabilities | null> {
    const resp = await this._doFetch('/api/documents/comments/capabilities', {
      method: 'GET',
    });
    if (!resp.ok) {
      this._capabilities = null;
      return null;
    }
    const body = (await resp.json()) as CommentsCapabilities;
    this._capabilities = body;
    return body;
  }

  // --- Public: anchor conversion ---

  /**
   * Build a CommentAnchor for the character range [from, to) in the base
   * Y.Text. Returns the full wire shape plus the Y.RelativePosition
   * serializations used for robust anchoring.
   */
  createAnchor(from: number, to: number): {
    anchor: CommentAnchor;
    startRel: Uint8Array;
    endRel: Uint8Array;
  } {
    const startRel = Y.createRelativePositionFromTypeIndex(this._ytext, from);
    const endRel = Y.createRelativePositionFromTypeIndex(this._ytext, to);
    const quoted = this._ytext.toString().slice(from, to);
    return {
      anchor: { start: from, end: to, quoted_text: quoted },
      startRel: Y.encodeRelativePosition(startRel),
      endRel: Y.encodeRelativePosition(endRel),
    };
  }

  /**
   * Resolve a stored thread's anchor to live {from, to} positions in the
   * current Y.Text. Uses RelativePosition when present; falls back to
   * fuzzy quoted_text match; returns null when the anchor is lost
   * (thread is orphaned).
   */
  resolveAnchor(thread: StoredThread): { from: number; to: number } | null {
    if (thread.start_rel && thread.end_rel) {
      const startRel = Y.decodeRelativePosition(base64Decode(thread.start_rel));
      const endRel = Y.decodeRelativePosition(base64Decode(thread.end_rel));
      const start = Y.createAbsolutePositionFromRelativePosition(startRel, this._ydoc);
      const end = Y.createAbsolutePositionFromRelativePosition(endRel, this._ydoc);
      if (start && end && start.type === this._ytext && end.type === this._ytext) {
        if (start.index <= end.index && end.index <= this._ytext.length) {
          // Sanity check the quoted text for unchanged anchors — if it
          // drifts, we still report the position but the caller can
          // decide whether the anchor is "valid" for inline decoration.
          return { from: start.index, to: end.index };
        }
      }
    }
    const quoted = thread.anchor.quoted_text ?? '';
    if (quoted.length > 0) {
      // Range anchor: fuzzy-match on the captured source text. When
      // present, this is the most accurate fallback under edits that
      // only moved the range.
      const txt = this._ytext.toString();
      const idx = txt.indexOf(quoted);
      if (idx >= 0) {
        return { from: idx, to: idx + quoted.length };
      }
      // Quoted text gone → thread truly orphaned.
      return null;
    }
    // Insert-only (zero-width) anchor — quoted_text is empty so fuzzy
    // matching is useless (indexOf('') = 0 would anchor every such
    // suggestion at the top of the doc, which was the root cause of
    // the "preview garbles the title" bug). Fall back to the absolute
    // offsets stored on the anchor at creation time, clamped to the
    // current Y.Text length. They may drift under concurrent edits but
    // are strictly better than 0.
    const len = this._ytext.length;
    const storedStart = Math.max(0, Math.min(thread.anchor.start, len));
    const storedEnd = Math.max(storedStart, Math.min(thread.anchor.end, len));
    return { from: storedStart, to: storedEnd };
  }

  /**
   * Resolve a thread's anchor by id. Public companion to `resolveAnchor`
   * for callers that only have the public CommentThread type (which
   * lacks the base64 RelativePositions stored internally).
   */
  resolveAnchorById(threadId: string): { from: number; to: number } | null {
    const raw = this._ymap.get(threadId);
    const thread = asStoredThread(raw);
    if (!thread) return null;
    return this.resolveAnchor(thread);
  }

  // --- Public: thread CRUD (writes to Y.Map, debounce-persists to SPI) ---

  /** Create a new thread. Returns the newly-generated thread id. */
  createThread(
    anchor: CommentAnchor,
    startRel: Uint8Array,
    endRel: Uint8Array,
    content: string | null,
    suggestion: Suggestion | null,
  ): string {
    this._enforceSize(content ?? '');
    if (suggestion?.author_note) this._enforceSize(suggestion.author_note);

    const threadId = makeId();
    const nowIso = new Date().toISOString();
    const stored: StoredThread = {
      anchor,
      start_rel: base64Encode(startRel),
      end_rel: base64Encode(endRel),
      status: 'open',
      comments: [],
      reactions: [],
      createdAt: nowIso,
    };
    if (content !== null && content !== '') {
      stored.comments.push({
        id: makeId(),
        thread_id: threadId,
        author_id: this._config.user.userId,
        author_name: this._config.user.userName,
        content,
        mentions: extractMentions(content),
        created_at: nowIso,
      });
    }
    if (suggestion) {
      stored.suggestion = {
        ...suggestion,
        status: suggestion.status ?? 'pending',
      } as Suggestion;
    }
    this._ydoc.transact(() => {
      this._ymap.set(threadId, stored);
    });
    return threadId;
  }

  /** Commit a suggestion, wrapping it into a new thread. */
  commitSuggestion(payload: SuggestionPayload): string {
    const startRel = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(this._ytext, payload.anchor.start),
    );
    const endRel = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(this._ytext, payload.anchor.end),
    );
    const suggestion: Suggestion = {
      yjs_payload: payload.yjs_payload,
      human_readable: payload.view,
      author_id: this._config.user.userId,
      author_name: this._config.user.userName,
      author_note: payload.author_note ?? undefined,
      status: 'pending',
    };
    return this.createThread(
      payload.anchor,
      startRel,
      endRel,
      null,
      suggestion,
    );
  }

  addReply(threadId: string, content: string): Comment | null {
    this._enforceSize(content);
    const thread = this._readThread(threadId);
    if (!thread) return null;
    const reply: Comment = {
      id: makeId(),
      thread_id: threadId,
      author_id: this._config.user.userId,
      author_name: this._config.user.userName,
      content,
      mentions: extractMentions(content),
      created_at: new Date().toISOString(),
    };
    this._ydoc.transact(() => {
      const updated: StoredThread = { ...thread, comments: [...thread.comments, reply] };
      this._ymap.set(threadId, updated);
    });
    return reply;
  }

  resolveThread(threadId: string): void {
    this._mutateThread(threadId, (t) => ({
      ...t,
      status: 'resolved',
      resolvedBy: this._config.user.userId,
      resolvedAt: new Date().toISOString(),
    }));
  }

  reopenThread(threadId: string): void {
    this._mutateThread(threadId, (t) => ({
      ...t,
      status: 'open',
      resolvedBy: undefined,
      resolvedAt: undefined,
    }));
  }

  deleteThread(threadId: string): void {
    this._ydoc.transact(() => {
      this._ymap.delete(threadId);
    });
    this._dirty.add(`__deleted__:${threadId}`);
    if (this._config.persistEnabled) this._schedulePersist();
  }

  editComment(threadId: string, commentId: string, content: string): void {
    if (!this._capabilities?.comment_edit) return;
    this._enforceSize(content);
    this._mutateThread(threadId, (t) => ({
      ...t,
      comments: t.comments.map((c) =>
        c.id === commentId
          ? {
              ...c,
              content,
              mentions: extractMentions(content),
              updated_at: new Date().toISOString(),
            }
          : c,
      ),
    }));
  }

  deleteComment(threadId: string, commentId: string): void {
    if (!this._capabilities?.comment_delete) return;
    const now = new Date().toISOString();
    this._mutateThread(threadId, (t) => ({
      ...t,
      comments: t.comments.map((c) =>
        c.id === commentId
          ? { ...c, content: '', mentions: [], deleted_at: now }
          : c,
      ),
    }));
  }

  addReaction(threadId: string, commentId: string | null, emoji: string): void {
    if (!this._capabilities || this._capabilities.reactions.length === 0) return;
    if (!this._capabilities.reactions.includes(emoji)) return;
    this._mutateThread(threadId, (t) => {
      const reaction: Reaction = {
        user_id: this._config.user.userId,
        user_name: this._config.user.userName,
        emoji,
        created_at: new Date().toISOString(),
      };
      if (commentId === null) {
        if ((t.reactions ?? []).some(
          (r) => r.user_id === reaction.user_id && r.emoji === emoji,
        )) return t;
        return { ...t, reactions: [...(t.reactions ?? []), reaction] };
      }
      return {
        ...t,
        comments: t.comments.map((c) =>
          c.id === commentId
            ? (c.reactions ?? []).some(
                (r) => r.user_id === reaction.user_id && r.emoji === emoji,
              )
              ? c
              : { ...c, reactions: [...(c.reactions ?? []), reaction] }
            : c,
        ),
      };
    });
  }

  removeReaction(threadId: string, commentId: string | null, emoji: string): void {
    this._mutateThread(threadId, (t) => {
      const uid = this._config.user.userId;
      const filter = (list: Reaction[] | undefined): Reaction[] =>
        (list ?? []).filter((r) => !(r.user_id === uid && r.emoji === emoji));
      if (commentId === null) {
        return { ...t, reactions: filter(t.reactions) };
      }
      return {
        ...t,
        comments: t.comments.map((c) =>
          c.id === commentId ? { ...c, reactions: filter(c.reactions) } : c,
        ),
      };
    });
  }

  decideSuggestion(threadId: string, decision: SuggestionStatus, appliedVersionId?: string): void {
    this._mutateThread(threadId, (t) => {
      if (!t.suggestion) return t;
      const now = new Date().toISOString();
      return {
        ...t,
        status: 'resolved',
        resolvedBy: this._config.user.userId,
        resolvedAt: now,
        suggestion: {
          ...t.suggestion,
          status: decision,
          decided_by: this._config.user.userId,
          decided_by_name: this._config.user.userName,
          decided_at: now,
          applied_version_id: appliedVersionId,
        },
      };
    });
  }

  // --- Public: reads ---

  getThreads(): CommentThread[] {
    const out: CommentThread[] = [];
    this._ymap.forEach((raw, threadId) => {
      const thread = asStoredThread(raw);
      if (!thread) return;
      out.push(toWireThread(threadId, thread, this._config.documentId));
    });
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  /**
   * Compute the suggestion-overlay regions to render. Each region is the
   * live resolved position of a pending suggestion's anchor. Suggestions
   * whose anchor is gone are omitted (the panel still shows them as
   * orphaned).
   */
  getSuggestionOverlays(userColor: (userId: string) => string): SuggestionOverlayRegion[] {
    const regions: SuggestionOverlayRegion[] = [];
    this._ymap.forEach((raw, threadId) => {
      const thread = asStoredThread(raw);
      if (!thread || !thread.suggestion || thread.suggestion.status !== 'pending') return;
      const resolved = this.resolveAnchor(thread);
      if (!resolved) return;
      regions.push({
        threadId,
        start: resolved.from,
        end: resolved.to,
        afterText: thread.suggestion.human_readable.after_text,
        operations: thread.suggestion.human_readable.operations,
        authorColor: userColor(thread.suggestion.author_id),
        status: thread.suggestion.status,
      });
    });
    return regions;
  }

  onThreadsChange(cb: (threads: CommentThread[]) => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  // --- Public: mentions ---

  async searchMentions(query: string, limit = 10): Promise<MentionCandidate[]> {
    if (!this._capabilities?.mentions) return [];
    const url = `/api/documents/comments/mentions/search?path=${encodeURIComponent(this._config.documentId)}&q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await this._doFetch(url, { method: 'GET' });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { candidates?: MentionCandidate[] };
    return body.candidates ?? [];
  }

  // --- Public: initial load from SPI ---

  async loadFromSPI(): Promise<void> {
    const resp = await this._doFetch(
      `/api/documents/comments?path=${encodeURIComponent(this._config.documentId)}`,
      { method: 'GET' },
    );
    if (!resp.ok) return;
    const body = (await resp.json()) as { threads?: CommentThreadListEntry[] };
    const entries = body.threads ?? [];
    for (const entry of entries) {
      // Only fetch each thread in full if it's not already in the Y.Map.
      if (this._ymap.has(entry.id)) continue;
      const detail = await this._doFetch(
        `/api/documents/comments/${encodeURIComponent(entry.id)}?path=${encodeURIComponent(this._config.documentId)}`,
        { method: 'GET' },
      );
      if (!detail.ok) continue;
      const thread = (await detail.json()) as CommentThread;
      // Tag the mutation with POLL_ORIGIN so the observeDeep handler
      // skips it — the thread is already persisted upstream, re-POSTing
      // it via the debounced loop would be an echo.
      this._ydoc.transact(() => {
        this._insertThreadFromWire(thread, /* markDirty */ false);
      }, POLL_ORIGIN);
    }
    // One-time garbage collection: historical bug created threads up front
    // (empty, no first comment) and left them forever when the user closed
    // the draft panel without typing. Sweep them here so they don't linger
    // as ghost anchors. New thread creation uses a draft-first flow, so
    // once all legacy empty threads are swept this is a no-op.
    for (const [id, raw] of this._ymap.entries()) {
      const t = asStoredThread(raw);
      if (!t) continue;
      if (t.comments.length === 0 && !t.suggestion) {
        this.deleteThread(id);
      }
    }
  }

  // --- Public: polling ---

  startPolling(): void {
    if (!this._capabilities?.poll_supported) return;
    if (this._config.pollIntervalMs <= 0) return;
    this.stopPolling();
    this._pollTimer = setInterval(() => void this.pollOnce(), this._config.pollIntervalMs);
  }

  stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Perform a single poll. Visible for testing; production callers should
   * prefer startPolling().
   */
  async pollOnce(): Promise<CommentChange[]> {
    if (typeof document !== 'undefined' && document.hasFocus && !document.hasFocus()) {
      return [];
    }
    const since = this._lastPollAt ?? new Date(0).toISOString();
    const resp = await this._doFetch(
      `/api/documents/comments/poll?path=${encodeURIComponent(this._config.documentId)}&since=${encodeURIComponent(since)}`,
      { method: 'GET' },
    );
    if (!resp.ok) return [];
    const body = (await resp.json()) as {
      changes?: CommentChange[];
      server_time?: string;
    };
    this._lastPollAt = body.server_time ?? new Date().toISOString();
    const changes = body.changes ?? [];
    if (changes.length > 0) {
      dlog('comments-poll', 'pollOnce — applying changes', {
        count: changes.length,
        actions: changes.map((c) => `${c.action}:${c.thread_id}`),
      });
    }
    for (const change of changes) {
      await this._reconcileChange(change);
    }
    return changes;
  }

  /** Explicitly flush pending persistence (tests + shutdown). */
  async flushNow(): Promise<void> {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    await this._persist();
  }

  destroy(): void {
    this.stopPolling();
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = null;
    this._listeners.clear();
    this._dirty.clear();
    this._lastPersisted.clear();
    this._retryCount.clear();
  }

  // --- Internal: mutators ---

  private _readThread(threadId: string): StoredThread | null {
    const raw = this._ymap.get(threadId);
    return asStoredThread(raw);
  }

  private _mutateThread(threadId: string, mutator: (t: StoredThread) => StoredThread): void {
    const existing = this._readThread(threadId);
    if (!existing) return;
    const next = mutator(existing);
    if (next === existing) return;
    this._ydoc.transact(() => {
      this._ymap.set(threadId, next);
    });
  }

  private _enforceSize(content: string): void {
    const limit = this._capabilities?.max_comment_size ?? 10 * 1024;
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > limit) {
      throw new Error(`comment exceeds max size of ${limit} bytes`);
    }
  }

  private _notifyListeners(): void {
    if (this._listeners.size === 0) return;
    const snapshot = this.getThreads();
    for (const cb of this._listeners) {
      try {
        cb(snapshot);
      } catch {
        // swallow: one bad listener must not derail the rest
      }
    }
  }

  // --- Internal: persistence ---

  private _schedulePersist(): void {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this._persist();
    }, this._config.persistDebounceMs);
  }

  private async _persist(): Promise<void> {
    if (this._dirty.size === 0) return;
    // Snapshot + drain, then re-queue on failure. Avoids losing writes
    // when a transient network error interrupts the loop — without this
    // the clear() at the top would orphan the unsent IDs forever.
    const ids = Array.from(this._dirty);
    this._dirty.clear();
    const failed: string[] = [];

    for (const key of ids) {
      let succeeded = false;
      try {
        if (key.startsWith('__deleted__:')) {
          const threadId = key.slice('__deleted__:'.length);
          const resp = await this._doFetch(
            `/api/documents/comments/${encodeURIComponent(threadId)}?path=${encodeURIComponent(this._config.documentId)}`,
            { method: 'DELETE' },
          );
          if (!resp.ok) throw new Error(`delete ${threadId}: ${resp.status}`);
          this._lastPersisted.delete(threadId);
          succeeded = true;
          continue;
        }

        const stored = this._readThread(key);
        if (!stored) {
          succeeded = true;
          continue;
        }
        const snapshot = JSON.stringify(stored);
        if (this._lastPersisted.get(key) === snapshot) {
          succeeded = true;
          continue;
        }

        const existingOnServer = this._lastPersisted.has(key);
        if (!existingOnServer) {
          // Thread-level create (may carry an initial comment + suggestion).
          // The client's Y.Map key is the authoritative thread ID: anchors
          // are stored in Y.RelativePosition relative to it, and resolve
          // PATCHes target /comments/{key}. If the provider generated its
          // own ID the two layers would diverge — resolves would hit 404
          // and the thread would stay "open" on the server while the
          // client considered it resolved. Ship the IDs explicitly.
          const url = `/api/documents/comments?path=${encodeURIComponent(this._config.documentId)}`;
          const body: any = {
            id: key,
            anchor: stored.anchor,
            suggestion: stored.suggestion,
          };
          if (stored.comments[0]) {
            body.comment = {
              id: stored.comments[0].id,
              author_id: stored.comments[0].author_id,
              author_name: stored.comments[0].author_name,
              content: stored.comments[0].content,
              mentions: stored.comments[0].mentions ?? [],
            };
          }
          const resp = await this._doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          // 409 means another peer already persisted the same ID via
          // CRDT sync. That's the expected multi-tab case — treat it as
          // success so we don't retry-loop.
          if (!resp.ok && resp.status !== 409) {
            throw new Error(`persist ${key}: ${resp.status}`);
          }
        } else {
          // Thread already on server. Diff the in-memory snapshot against
          // what we last successfully persisted, then emit the individual
          // endpoint calls that cover the deltas. Without this, replies
          // added after thread creation never reach the SPI — they live
          // only in the local Y.Map until a poll reconcile overwrites the
          // thread with server state, at which point the replies vanish.
          const prev = this._lastPersisted.get(key);
          const prevThread = prev
            ? (JSON.parse(prev) as StoredThread)
            : null;
          const prevCommentIds = new Set(
            (prevThread?.comments ?? []).map((c) => c.id),
          );
          const newComments = stored.comments.filter(
            (c) => !prevCommentIds.has(c.id) && !c.deleted_at,
          );
          for (const c of newComments) {
            const resp = await this._doFetch(
              `/api/documents/comments/${encodeURIComponent(key)}/replies?path=${encodeURIComponent(this._config.documentId)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: c.id,
                  author_id: c.author_id,
                  author_name: c.author_name,
                  content: c.content,
                  mentions: c.mentions ?? [],
                }),
              },
            );
            if (!resp.ok) throw new Error(`reply ${key}:${c.id}: ${resp.status}`);
          }

          if (!prevThread || prevThread.status !== stored.status) {
            const resp = await this._doFetch(
              `/api/documents/comments/${encodeURIComponent(key)}?path=${encodeURIComponent(this._config.documentId)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  status: stored.status,
                  resolved_by: stored.resolvedBy,
                }),
              },
            );
            if (!resp.ok) throw new Error(`status ${key}: ${resp.status}`);
          }

          // Bug A: persist accept/reject decisions. The thread-status
          // PATCH above only carries {status, resolved_by} — it does
          // not transport the suggestion sub-object. The dedicated
          // /suggestion/decision endpoint records the
          // accepted/rejected outcome plus decided_by + applied_version_id.
          // Skip when the suggestion is still pending (covers the
          // create path, which already POST'd the suggestion via the
          // thread-create body).
          const prevSuggestionStatus = prevThread?.suggestion?.status;
          const newSuggestionStatus = stored.suggestion?.status;
          if (
            stored.suggestion &&
            newSuggestionStatus &&
            newSuggestionStatus !== 'pending' &&
            prevSuggestionStatus !== newSuggestionStatus
          ) {
            const resp = await this._doFetch(
              `/api/documents/comments/${encodeURIComponent(key)}/suggestion/decision?path=${encodeURIComponent(this._config.documentId)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  decision: newSuggestionStatus,
                  decided_by: stored.suggestion.decided_by ?? '',
                  applied_version_id: stored.suggestion.applied_version_id,
                }),
              },
            );
            if (!resp.ok) throw new Error(`decide ${key}: ${resp.status}`);
          }
        }
        this._lastPersisted.set(key, snapshot);
        succeeded = true;
      } catch (err) {
        // Re-queue on failure so the next debounce retries. Network
        // errors, 5xx, and 4xx all land here, but we cap attempts per
        // key so a permanent 401/403/404/409 doesn't cause an infinite
        // retry storm.
        const attempts = (this._retryCount.get(key) ?? 0) + 1;
        if (attempts >= CommentEngine.MAX_PERSIST_RETRIES) {
          console.error(
            'comment-engine: giving up after max retries',
            key,
            attempts,
            err,
          );
          this._retryCount.delete(key);
          continue;
        }
        this._retryCount.set(key, attempts);
        console.warn(
          'comment-engine: persist failed, will retry',
          key,
          `(attempt ${attempts}/${CommentEngine.MAX_PERSIST_RETRIES})`,
          err,
        );
        failed.push(key);
      } finally {
        // Covers all success + no-op paths (including `continue` exits);
        // the catch branch already handled its own retryCount updates.
        if (succeeded) this._retryCount.delete(key);
      }
    }

    if (failed.length > 0) {
      for (const key of failed) this._dirty.add(key);
      this._schedulePersist();
    }
  }

  // --- Internal: polling reconciliation ---

  private async _reconcileChange(change: CommentChange): Promise<void> {
    if (change.action === 'deleted') {
      this._ydoc.transact(() => {
        this._ymap.delete(change.thread_id);
      }, POLL_ORIGIN);
      return;
    }
    const detail = await this._doFetch(
      `/api/documents/comments/${encodeURIComponent(change.thread_id)}?path=${encodeURIComponent(this._config.documentId)}`,
      { method: 'GET' },
    );
    if (!detail.ok) return;
    const thread = (await detail.json()) as CommentThread;
    this._ydoc.transact(() => {
      this._insertThreadFromWire(thread, /* markDirty */ false);
    }, POLL_ORIGIN);
  }

  private _insertThreadFromWire(thread: CommentThread, markDirty: boolean): void {
    // Bug A poll-race guard: if the local Y.Map already has a
    // suggestion with a non-pending decision (accepted/rejected),
    // and the wire response still carries it as 'pending' — the
    // server hasn't applied our in-flight POST /suggestion/decision
    // yet. Overwriting would clobber the local decision, which then
    // never gets re-persisted (POLL_ORIGIN suppresses dirty-marking).
    // Preserve the local decision; the next persist flush will catch
    // the server up.
    const existing = asStoredThread(this._ymap.get(thread.id));
    const localDecided =
      existing?.suggestion &&
      existing.suggestion.status !== 'pending';
    const wirePending =
      !thread.suggestion || thread.suggestion.status === 'pending';
    let suggestionToStore = thread.suggestion;
    if (localDecided && wirePending) {
      suggestionToStore = existing!.suggestion;
    }

    const stored: StoredThread = {
      anchor: thread.anchor,
      status: thread.status,
      resolvedBy: thread.resolved_by,
      resolvedAt: thread.resolved_at,
      comments: thread.comments,
      reactions: thread.reactions,
      suggestion: suggestionToStore,
      createdAt: thread.created_at,
    };
    this._ymap.set(thread.id, stored);
    // Record the persisted snapshot so the persistence loop doesn't
    // treat the freshly-loaded thread as "new, needs POST". Use the
    // wire shape (not the locally-merged shape) so the in-flight
    // decision still looks "dirty" relative to last-persisted on the
    // next flush.
    const wireSnapshot: StoredThread = { ...stored, suggestion: thread.suggestion };
    this._lastPersisted.set(thread.id, JSON.stringify(wireSnapshot));
    if (!markDirty) this._dirty.delete(thread.id);
    // If we preserved a local decision, mark the thread dirty so the
    // next flush re-sends the decision.
    if (localDecided && wirePending) {
      this._dirty.add(thread.id);
      if (this._config.persistEnabled) this._schedulePersist();
    }
  }

  // --- Internal: HTTP ---

  private async _doFetch(path: string, init: RequestInit): Promise<Response> {
    const url = this._config.relayUrl.replace(/\/+$/, '') + path;
    return this._config.fetchImpl(url, {
      credentials: 'include',
      ...init,
    });
  }
}

// --- Helpers ---

function makeId(): string {
  const crypto = (globalThis as any).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @-mention tokens: "@[Display Name](user-id)". */
const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;
export function extractMentions(content: string): Mention[] {
  const out: Mention[] = [];
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(content)) !== null) {
    out.push({ user_id: m[2], display_name: m[1] });
  }
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(s);
  // Node fallback — `Buffer` is a global in Node; avoid a direct import so
  // this module stays browser-friendly.
  const b = (globalThis as any).Buffer;
  return b ? b.from(bytes).toString('base64') : s;
}

function base64Decode(s: string): Uint8Array {
  let bin: string;
  if (typeof atob !== 'undefined') {
    bin = atob(s);
  } else {
    const b = (globalThis as any).Buffer;
    bin = b ? b.from(s, 'base64').toString('binary') : s;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asStoredThread(raw: any): StoredThread | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.anchor || !Array.isArray(raw.comments)) return null;
  return raw as StoredThread;
}

function toWireThread(
  threadId: string,
  stored: StoredThread,
  documentId: string,
): CommentThread {
  return {
    id: threadId,
    document_id: documentId,
    anchor: stored.anchor,
    status: stored.status,
    created_at: stored.createdAt,
    resolved_at: stored.resolvedAt,
    resolved_by: stored.resolvedBy,
    comments: stored.comments,
    reactions: stored.reactions,
    suggestion: stored.suggestion,
  };
}

function findThreadId(target: unknown, root: Y.Map<any>): string | null {
  // Y.Map's observeDeep doesn't hand us a path; but nested sub-structures
  // are all JS objects stored by-value, so we never get here. Retained for
  // defensive safety in case we later migrate to nested Y.Maps.
  let key: string | null = null;
  root.forEach((v, k) => {
    if (v === target) key = k;
  });
  return key;
}
