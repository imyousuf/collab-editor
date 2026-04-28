/**
 * SuggestEngine — Suggest Mode controller over the syncDoc/editorDoc split.
 *
 * When Suggest Mode is enabled, the engine closes the replicator's outbound
 * gate so local edits on `editorDoc` do not propagate to `syncDoc` (and
 * therefore to peers). The editor continues to receive inbound peer updates
 * so the user sees concurrent activity.
 *
 * On submit or discard, the engine calls `collab.resetEditorDoc()` which
 * destroys the current `editorDoc` (throwing away local drafts and the
 * resulting tombstoned CRDT ops), recreates it from `syncDoc`'s state, and
 * fires subscribers so bindings rebind to the fresh `editorText`. The
 * outbound gate reopens afterwards.
 *
 * The payload built on submit is text-level: `{before_text, after_text,
 * anchor, view}` — no `yjs_payload`. Accept applies a text-level diff to
 * `syncText` (handled in multi-editor).
 */
import type { CommentAnchor, OperationSummary, SuggestionView } from '../interfaces/comments.js';
import type { SuggestionPayload, SuggestRebaseWarning } from '../interfaces/suggest.js';
import type { ICollaborationProvider } from '../interfaces/collaboration.js';

export interface SuggestEngineConfig {
  user: { userId: string; userName: string; userColor?: string };
  /** MIME type of the document content. Used to label the replacement. */
  mimeType?: string;
}

export class SuggestEngine {
  private readonly _collab: ICollaborationProvider;
  private readonly _config: SuggestEngineConfig;
  private _enabled = false;
  private _destroyed = false;
  private _textAtEnable = '';
  private _warningListeners = new Set<(w: SuggestRebaseWarning) => void>();

  constructor(collab: ICollaborationProvider, config: SuggestEngineConfig) {
    this._collab = collab;
    this._config = config;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Enter Suggest Mode. Closes the replicator's outbound gate and records
   * the editor-native serialized text as the enable-time "before" snapshot.
   * Subsequent edits on `editorDoc` stay local until submit or discard.
   */
  enable(currentText: string): void {
    if (this._destroyed) return;
    if (this._enabled) return;
    this._textAtEnable = currentText;
    this._collab.replicator.outboundOpen = false;
    this._enabled = true;
  }

  /**
   * Exit Suggest Mode without performing a reset. Reopens the outbound
   * gate. Callers that want to revert drafts should use `discard()` or
   * `commit()` instead — those call `resetEditorDoc()` before reopening.
   */
  disable(): void {
    if (!this._enabled) return;
    this._collab.replicator.outboundOpen = true;
    this._enabled = false;
    this._textAtEnable = '';
  }

  getBeforeText(): string {
    return this._textAtEnable;
  }

  /** Whether the current editor text differs from the text captured at enable. */
  hasPendingChanges(currentText: string): boolean {
    if (!this._enabled) return false;
    return currentText !== this._textAtEnable;
  }

  /**
   * Update the captured baseline without exiting Suggest Mode.
   *
   * Why: when an external mutation lands on syncText (e.g. the reviewer
   * accepts a peer's suggestion via `applyStringDiff`), the replicator
   * mirrors it into editorText. The user did not draft that change, but
   * `_textAtEnable` still points at the pre-mutation text, so the next
   * `hasPendingChanges()` would false-positive and the toolbar's "Exit"
   * button would surface a "submit pending suggestions?" prompt for
   * changes the user never made. Callers re-baseline after the
   * mutation so the engine tracks only genuine local drafts going
   * forward. The outbound gate stays closed — Suggest Mode is unchanged.
   */
  rebase(newBaseline: string): void {
    if (!this._enabled) return;
    this._textAtEnable = newBaseline;
  }

  /**
   * Build a submission payload from the current editor text. Does NOT
   * reset the editor or reopen the gate — use `commit()` to do both.
   */
  buildSuggestion(authorNote: string | null, currentText: string): SuggestionPayload {
    if (!this._enabled) throw new Error('Suggest Mode is not active');
    if (currentText === this._textAtEnable) throw new Error('no pending changes to commit');

    const beforeText = this._textAtEnable;
    const afterText = currentText;
    const anchor = computeAnchor(beforeText, afterText);
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
      view,
      author_note: authorNote && authorNote.length > 0 ? authorNote : null,
    };
  }

  /**
   * Build the payload, reset editorDoc (visual revert), and reopen the
   * outbound gate. Returns the payload for the caller to pass into
   * `CommentEngine.commitSuggestion(...)`.
   */
  commit(authorNote: string | null, currentText: string): SuggestionPayload {
    const payload = this.buildSuggestion(authorNote, currentText);
    this._collab.resetEditorDoc();
    this.disable();
    return payload;
  }

  /** Revert local drafts without submitting: reset editorDoc + reopen gate. */
  discard(): void {
    if (!this._enabled) return;
    this._collab.resetEditorDoc();
    this.disable();
  }

  onRebaseWarning(cb: (w: SuggestRebaseWarning) => void): () => void {
    this._warningListeners.add(cb);
    return () => this._warningListeners.delete(cb);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._enabled) this.disable();
    this._warningListeners.clear();
  }
}

// --- Diff helpers ---

/**
 * Compute the smallest character-offset range `[start, end)` in the base
 * text that encloses every change relative to `afterText`.
 */
function computeAnchor(baseText: string, afterText: string): CommentAnchor {
  let prefix = 0;
  const minLen = Math.min(baseText.length, afterText.length);
  while (prefix < minLen && baseText[prefix] === afterText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    baseText[baseText.length - 1 - suffix] === afterText[afterText.length - 1 - suffix]
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
  afterText: string,
  anchor: CommentAnchor,
): OperationSummary[] {
  const before = baseText.slice(anchor.start, anchor.end);
  const after = afterText.slice(
    anchor.start,
    anchor.end + (afterText.length - baseText.length),
  );
  if (before === after) return [];
  if (before.length === 0 && after.length > 0) {
    return [{ kind: 'insert', offset: anchor.start, length: 0, inserted_text: after }];
  }
  if (before.length > 0 && after.length === 0) {
    return [{ kind: 'delete', offset: anchor.start, length: before.length }];
  }
  return [{ kind: 'replace', offset: anchor.start, length: before.length, inserted_text: after }];
}

function generateSummary(
  operations: OperationSummary[],
  anchor: CommentAnchor,
  baseText: string,
  _afterText: string,
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
  const before = truncate(baseText.slice(anchor.start, anchor.end), 40);
  const after = truncate(op.inserted_text ?? '', 40);
  return `Change "${before}" to "${after}"`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
