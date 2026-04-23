/**
 * SuggestEngine — the per-user, per-document Suggest Mode buffer.
 *
 * When the user toggles Suggest Mode on, this engine creates a private
 * Y.Doc seeded from the current base Y.Text state. Bindings redirect the
 * editor's writes into this buffer Y.Text instead of the shared one.
 * Remote updates to the base are replayed onto the buffer so local edits
 * automatically rebase on concurrent activity.
 *
 * On commit, the accumulated operations are encoded as a base64 Y.js
 * update (opaque to the SPI) and accompanied by a human-readable
 * SuggestionView derived by diffing base vs buffer text.
 *
 * The engine is deliberately Yjs-aware — the entire point is to capture
 * Y.Text operations deterministically for later replay via Y.applyUpdate.
 */

import * as Y from 'yjs';
import { computeLineDiff, type DiffLine } from './diff-engine.js';
import type { CommentAnchor, OperationSummary, SuggestionView } from '../interfaces/comments.js';
import type { SuggestionPayload, SuggestRebaseWarning } from '../interfaces/suggest.js';

export interface SuggestEngineConfig {
  user: { userId: string; userName: string; userColor?: string };
  /** MIME type of the document content. Used to label the replacement. */
  mimeType?: string;
}

const BUFFER_ORIGIN = Symbol('suggest-buffer');
const REBASE_ORIGIN = Symbol('suggest-rebase');

export class SuggestEngine {
  private readonly _baseDoc: Y.Doc;
  private readonly _baseText: Y.Text;
  private readonly _config: SuggestEngineConfig;

  private _bufferDoc: Y.Doc | null = null;
  private _bufferText: Y.Text | null = null;
  private _baseSnapshotAtEnable = '';
  /** State vector of the buffer at enable-time — used to encode the minimal diff on commit. */
  private _bufferStateAtEnable: Uint8Array | null = null;
  private _baseUpdateUnsub: (() => void) | null = null;
  private _warningListeners = new Set<(w: SuggestRebaseWarning) => void>();
  private _bufferChangeListeners = new Set<() => void>();
  private _bufferObserver: (() => void) | null = null;

  constructor(baseDoc: Y.Doc, baseText: Y.Text, config: SuggestEngineConfig) {
    this._baseDoc = baseDoc;
    this._baseText = baseText;
    this._config = config;
  }

  isEnabled(): boolean {
    return this._bufferDoc !== null;
  }

  /**
   * Turn Suggest Mode on. Creates a private Y.Doc + Y.Text seeded from
   * the base state, and starts forwarding base updates onto the buffer.
   *
   * `currentText` is the editor-native serialized form (e.g. Tiptap's
   * markdown output) captured at enable-time. It's stored as the
   * "before" snapshot for the diff view. Capturing it here — rather
   * than reading `baseText.toString()` — keeps the diff symmetric with
   * the "after" snapshot we capture at submit time: both go through
   * the same serializer, so normalization drift between raw Y.Text and
   * Tiptap's output doesn't show up as a spurious whole-document
   * change in the comment panel.
   */
  enable(currentText?: string): { bufferDoc: Y.Doc; bufferText: Y.Text } {
    if (this._bufferDoc && this._bufferText) {
      return { bufferDoc: this._bufferDoc, bufferText: this._bufferText };
    }

    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    this._bufferDoc = bufferDoc;
    this._bufferText = bufferText;

    // Seed the buffer with the current base Y.Text content. Doing this
    // via applyUpdate preserves clientIDs and Y.js item structure, which
    // keeps our later `encodeStateAsUpdate(bufferDoc, baseStateVector)`
    // minimal (only local ops are encoded, not the seed).
    const baseUpdate = Y.encodeStateAsUpdate(this._baseDoc);
    Y.applyUpdate(bufferDoc, baseUpdate, REBASE_ORIGIN);

    this._baseSnapshotAtEnable = currentText ?? this._baseText.toString();
    this._bufferStateAtEnable = Y.encodeStateVector(bufferDoc);

    // Rebase observer — pipe base updates onto the buffer so local
    // suggestions adapt to concurrent peers.
    const rebaseHandler = (update: Uint8Array, origin: unknown) => {
      // Don't loop on our own writes.
      if (origin === REBASE_ORIGIN) return;
      if (!this._bufferDoc) return;
      const prevLength = this._bufferText?.toString().length ?? 0;
      Y.applyUpdate(this._bufferDoc, update, REBASE_ORIGIN);
      const newLength = this._bufferText?.toString().length ?? 0;
      if (newLength < prevLength) {
        // Approximation: remote deletion removed characters. If the
        // buffer shrank more than the base did, surface a warning.
        const baseLen = this._baseText.length;
        const dropped = prevLength - newLength - Math.max(0, prevLength - baseLen);
        if (dropped > 0) {
          for (const cb of this._warningListeners) {
            try {
              cb({
                message:
                  'Part of your suggestion was invalidated by a concurrent edit.',
                droppedOperations: dropped,
              });
            } catch {
              /* swallow */
            }
          }
        }
      }
    };
    this._baseDoc.on('update', rebaseHandler);
    this._baseUpdateUnsub = () => this._baseDoc.off('update', rebaseHandler);

    // Observe buffer changes to notify listeners (the coordinator uses
    // this to push pending overlay decorations to the binding).
    const observer = () => {
      for (const cb of this._bufferChangeListeners) {
        try { cb(); } catch { /* swallow */ }
      }
    };
    bufferText.observe(observer);
    this._bufferObserver = () => bufferText.unobserve(observer);

    return { bufferDoc, bufferText };
  }

  /** Turn Suggest Mode off and discard any pending operations. */
  disable(): void {
    this._baseUpdateUnsub?.();
    this._baseUpdateUnsub = null;
    this._bufferObserver?.();
    this._bufferObserver = null;
    if (this._bufferDoc) {
      this._bufferDoc.destroy();
    }
    this._bufferDoc = null;
    this._bufferText = null;
    this._baseSnapshotAtEnable = '';
    this._bufferStateAtEnable = null;
  }

  getBufferDoc(): Y.Doc | null {
    return this._bufferDoc;
  }

  getBufferText(): Y.Text | null {
    return this._bufferText;
  }

  hasPendingChanges(): boolean {
    if (!this._bufferText) return false;
    return this._bufferText.toString() !== this._baseText.toString();
  }

  onBufferChange(cb: () => void): () => void {
    this._bufferChangeListeners.add(cb);
    return () => this._bufferChangeListeners.delete(cb);
  }

  onRebaseWarning(cb: (w: SuggestRebaseWarning) => void): () => void {
    this._warningListeners.add(cb);
    return () => this._warningListeners.delete(cb);
  }

  /**
   * Build a commit payload from the current buffer state. Throws if
   * there are no pending changes. The caller provides an optional
   * author note (max 10 KB) and, critically, `currentText` — the
   * editor-native serialized form at submit-time. This pairs with the
   * `currentText` captured at `enable()` to make the diff symmetric
   * (both sides go through the same serializer).
   */
  buildSuggestion(authorNote: string | null, currentText?: string): SuggestionPayload {
    if (!this._bufferDoc || !this._bufferText || !this._bufferStateAtEnable) {
      throw new Error('Suggest Mode is not active');
    }
    if (!this.hasPendingChanges()) {
      throw new Error('no pending changes to commit');
    }

    // Diff view inputs: use the serialized snapshots captured via the
    // editor's native serializer. Falling back to Y.Text content only
    // when the caller didn't supply the current text, for backwards
    // compatibility with older call sites.
    const beforeText = this._baseSnapshotAtEnable;
    const afterText = currentText ?? this._bufferText.toString();
    const anchor = computeAnchor(beforeText, afterText);

    const yjsUpdate = Y.encodeStateAsUpdate(this._bufferDoc, this._bufferStateAtEnable);
    const operations = toOperationSummaries(beforeText, afterText, anchor);
    const view: SuggestionView = {
      summary: generateSummary(operations, anchor, beforeText, afterText),
      before_text: beforeText.slice(anchor.start, anchor.end),
      after_text: afterText.slice(
        anchor.start,
        anchor.end + (afterText.length - beforeText.length),
      ),
      operations,
    };

    return {
      anchor,
      yjs_payload: base64Encode(yjsUpdate),
      view,
      author_note: authorNote && authorNote.length > 0 ? authorNote : null,
    };
  }

  /** Reset the buffer to the current base state without exiting Suggest Mode. */
  clear(): void {
    if (!this.isEnabled()) return;
    this.disable();
    this.enable();
  }
}

// --- Diff helpers ---

/**
 * Compute the smallest character-offset range `[start, end)` in the base
 * text that encloses every change relative to `bufferText`. The range is
 * always reported against the BASE document (since that's what the
 * anchor will be resolved against later).
 */
function computeAnchor(baseText: string, bufferText: string): CommentAnchor {
  // Walk from both ends to find the common prefix/suffix lengths.
  let prefix = 0;
  const minLen = Math.min(baseText.length, bufferText.length);
  while (prefix < minLen && baseText[prefix] === bufferText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    baseText[baseText.length - 1 - suffix] === bufferText[bufferText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const start = prefix;
  const end = Math.max(prefix, baseText.length - suffix);
  return {
    start,
    end,
    quoted_text: baseText.slice(start, end),
  };
}

function toOperationSummaries(
  baseText: string,
  bufferText: string,
  anchor: CommentAnchor,
): OperationSummary[] {
  const before = baseText.slice(anchor.start, anchor.end);
  const after = bufferText.slice(
    anchor.start,
    anchor.end + (bufferText.length - baseText.length),
  );
  if (before === after) return [];
  if (before.length === 0 && after.length > 0) {
    return [
      {
        kind: 'insert',
        offset: anchor.start,
        length: 0,
        inserted_text: after,
      },
    ];
  }
  if (before.length > 0 && after.length === 0) {
    return [
      {
        kind: 'delete',
        offset: anchor.start,
        length: before.length,
      },
    ];
  }
  return [
    {
      kind: 'replace',
      offset: anchor.start,
      length: before.length,
      inserted_text: after,
    },
  ];
}

function generateSummary(
  operations: OperationSummary[],
  anchor: CommentAnchor,
  baseText: string,
  bufferText: string,
): string {
  if (operations.length === 0) return 'No changes';
  const op = operations[0];
  if (operations.length > 1) {
    return `Mixed edits (${operations.length} ops)`;
  }
  if (op.kind === 'insert') {
    const snippet = truncate(op.inserted_text ?? '', 40);
    return `Insert "${snippet}"`;
  }
  if (op.kind === 'delete') {
    return `Delete ${op.length} characters`;
  }
  // replace
  const before = truncate(baseText.slice(anchor.start, anchor.end), 40);
  const after = truncate(op.inserted_text ?? '', 40);
  return `Change "${before}" to "${after}"`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// --- base64 (browser + node compatible) ---

function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(s);
  const b = (globalThis as any).Buffer;
  return b ? b.from(bytes).toString('base64') : s;
}

// Tests may want to exercise the diff engine directly.
export function diffForTest(a: string, b: string): DiffLine[] {
  return computeLineDiff(a, b);
}
