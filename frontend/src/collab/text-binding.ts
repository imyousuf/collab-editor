/**
 * Y.Text ↔ Tiptap bidirectional sync with diff-based updates.
 *
 * Content flow:
 *   Y.Text → TextBinding → Tiptap  (remote changes, initial load)
 *   Tiptap → TextBinding → Y.Text  (local user edits only)
 *
 * Echo prevention uses two layers:
 * 1. Guard flag (_applyingFromYText) — blocks the debounce from starting
 *    during Y.Text→Tiptap application, so setContent() cannot trigger a
 *    write-back cycle.
 * 2. Content snapshot (_lastAppliedFromYText) — if a debounce does fire,
 *    compares serialized output against the last snapshot to detect echoes.
 */
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import type { IContentHandler } from '../interfaces/content-handler.js';

export class TextBinding {
  private _editor: Editor;
  private _ytext: Y.Text;
  private _handler: IContentHandler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _editorHandler: ((...args: any[]) => void) | null = null;
  private _ytextObserver: ((event: Y.YTextEvent) => void) | null = null;
  private _syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _origin = Symbol('TextBinding');

  /**
   * Snapshot of the last content applied TO Tiptap from Y.Text.
   * When Tiptap fires `update`, we compare its serialized output
   * against this snapshot. If they match (or the diff is only
   * normalization), we skip the write-back to Y.Text.
   */
  private _lastAppliedFromYText: string = '';

  /**
   * Guard flag: true while we are applying Y.Text content to Tiptap.
   * Prevents Tiptap's 'update' event (fired synchronously by setContent)
   * from starting a debounce timer that would write normalized content
   * back to Y.Text — which corrupts the source editor's view.
   */
  private _applyingFromYText = false;

  /**
   * When true, the Tiptap→Y.Text sync direction is completely disabled.
   * Used when the source (CodeMirror) editor is active — yCollab handles
   * CodeMirror→Y.Text sync, so TextBinding should only sync Y.Text→Tiptap
   * (one-directional) to keep the hidden Tiptap up to date.
   */
  private _paused = false;
  private _ytextPendingApply = false;

  constructor(editor: Editor, ytext: Y.Text, handler: IContentHandler) {
    this._editor = editor;
    this._ytext = ytext;
    this._handler = handler;

    // If Y.Text already has content, render it in Tiptap
    if (ytext.length > 0) {
      this._applyYTextToEditor();
    }

    // Tiptap → Y.Text: debounced, only for genuine user edits in WYSIWYG mode
    this._editorHandler = ({ transaction }: any) => {
      // Skip metadata-only transactions (e.g., blame plugin decoration updates).
      if (transaction && !transaction.docChanged) return;
      // Skip when paused (source mode active — yCollab handles sync).
      if (this._paused) return;
      // Skip events triggered by our own Y.Text→Tiptap application.
      if (this._applyingFromYText) return;

      if (this._syncTimer) clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => {
        this._applyEditorToYText();
      }, 100);
    };
    this._editor.on('update', this._editorHandler);

    // Y.Text → Tiptap: deferred to microtask to avoid running setContent
    // inside a Y.Doc transaction (which disrupts CodeMirror keystroke processing).
    // When paused (source mode), skip entirely — sync on unpause instead.
    this._ytextPendingApply = false;
    this._ytextObserver = (event) => {
      // Skip our own writes
      if (event.transaction.origin === this._origin) return;
      // When paused, skip Y.Text→Tiptap sync entirely.
      // The hidden Tiptap will get a single sync when setPaused(false) is called.
      if (this._paused) return;
      if (!this._ytextPendingApply) {
        this._ytextPendingApply = true;
        queueMicrotask(() => {
          this._ytextPendingApply = false;
          this._applyYTextToEditor();
        });
      }
    };
    this._ytext.observe(this._ytextObserver);
  }

  /** Load initial content. Only writes to Y.Text if it's empty. */
  loadInitialContent(text: string): void {
    if (this._ytext.length > 0) {
      this._applyYTextToEditor();
      return;
    }
    this._ytext.doc?.transact(() => {
      this._ytext.insert(0, text);
    }, this._origin);
    this._applyContentToEditor(text);
    this._lastAppliedFromYText = this._getSerializedContent();
  }

  /**
   * Pause/resume the Tiptap→Y.Text sync direction.
   * When paused, Y.Text→Tiptap still works (keeps hidden Tiptap up to date),
   * but Tiptap changes are NOT written back to Y.Text.
   * Call with `true` when source mode is active (yCollab handles sync).
   * Call with `false` when switching back to WYSIWYG mode.
   */
  setPaused(paused: boolean): void {
    this._paused = paused;
    if (paused) {
      // Cancel any pending Tiptap→Y.Text write-back
      if (this._syncTimer) {
        clearTimeout(this._syncTimer);
        this._syncTimer = null;
      }
    } else {
      // Sync current Y.Text to Tiptap on unpause — the hidden
      // Tiptap may have missed changes while paused.
      this._applyYTextToEditor();
    }
  }

  /**
   * Swap the Y.Text this binding is attached to. Used by Suggest Mode to
   * redirect editor writes into a per-user buffer Y.Doc while leaving the
   * shared base Y.Doc untouched.
   *
   * Teardown contract: the OLD Y.Text is unobserved exactly once, a
   * pending write-back (if any) is cancelled, and the NEW Y.Text is
   * observed with the same observer instance.
   *
   * Important: we only re-run `_applyYTextToEditor` when the NEW target's
   * raw string actually differs from the OLD target's raw string. In the
   * Suggest-enable path the buffer is seeded byte-for-byte from the base
   * via `Y.applyUpdate`, so the two match and a setContent would be a
   * pointless re-parse. Tiptap's markdown round-trip isn't perfectly
   * idempotent with raw Y.Text markdown, so forcing an unnecessary
   * re-parse would collapse structure (headings/lists/paragraphs get
   * inlined), which then shows up on submit as a whole-document diff.
   */
  retargetYText(newYText: Y.Text): void {
    if (newYText === this._ytext) return;
    if (this._syncTimer) {
      clearTimeout(this._syncTimer);
      this._syncTimer = null;
    }
    // Compare against the editor's current serialized content instead of
    // the old Y.Text's string — on the editorDoc-reset path the old
    // Y.Text's host doc is already destroyed, and toString() would read
    // stale/undefined state. Editor-content-vs-new-Y.Text also covers
    // the case we care about ("do I need to re-apply?").
    let currentContent = '';
    try { currentContent = this._getSerializedContent(); } catch { /* fall through */ }
    const newContent = newYText.toString();
    const contentChanged = currentContent !== newContent;
    if (this._ytextObserver) {
      try { this._ytext.unobserve(this._ytextObserver); } catch { /* old doc destroyed */ }
    }
    this._ytext = newYText;
    if (this._ytextObserver) {
      newYText.observe(this._ytextObserver);
    }
    if (contentChanged) {
      this._applyYTextToEditor();
    }
  }

  /** Current Y.Text target — exposed for tests and downstream plugins. */
  get ytext(): Y.Text {
    return this._ytext;
  }

  private _applyEditorToYText(): void {
    const serialized = this._getSerializedContent();
    const current = this._ytext.toString();

    // Skip if content matches what was last applied from Y.Text.
    // This prevents the echo: Y.Text → Tiptap → (normalized) → Y.Text
    if (serialized === current) return;
    if (serialized === this._lastAppliedFromYText) return;

    // Only write if content actually differs from Y.Text
    this._ytext.doc?.transact(() => {
      applyStringDiff(this._ytext, current, serialized);
    }, this._origin);
  }

  private _applyYTextToEditor(): void {
    const text = this._ytext.toString();
    if (!text && this._ytext.length === 0) return;

    // Cancel any pending Tiptap → Y.Text write-back before applying remote content.
    // Without this, the old debounce could fire after setContent and write Tiptap's
    // normalized HTML back to Y.Text, overwriting concurrent remote changes.
    if (this._syncTimer) {
      clearTimeout(this._syncTimer);
      this._syncTimer = null;
    }

    // Guard: setContent fires Tiptap's 'update' event synchronously.
    // The flag prevents our handler from starting a debounce timer that
    // would write normalized content back to Y.Text (corrupting source).
    this._applyingFromYText = true;
    this._applyContentToEditor(text);
    this._applyingFromYText = false;

    // Store what Tiptap WILL serialize (after normalization) as the snapshot.
    // This is a secondary echo prevention: if a debounce somehow starts,
    // _applyEditorToYText() will see the match and skip the write.
    this._lastAppliedFromYText = this._getSerializedContent();
  }

  private _applyContentToEditor(text: string): void {
    const parsed = this._handler.parse(text);
    if (parsed.type === 'markdown') {
      this._editor.commands.setContent(text, { contentType: 'markdown' } as any);
    } else {
      this._editor.commands.setContent(text);
    }
  }

  private _getSerializedContent(): string {
    const type = this._handler.parse('').type;
    if (type === 'markdown') {
      return this._editor.getMarkdown?.() ?? this._editor.getHTML();
    }
    return this._editor.getHTML();
  }

  destroy(): void {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    if (this._editorHandler) {
      this._editor.off('update', this._editorHandler);
    }
    if (this._ytextObserver) {
      this._ytext.unobserve(this._ytextObserver);
    }
  }
}

/**
 * Apply a string diff to a Y.Text using common prefix/suffix.
 * Only deletes and inserts the changed region — preserves CRDT cursors.
 */
export function applyStringDiff(ytext: Y.Text, oldStr: string, newStr: string): void {
  let prefixLen = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < (minLen - prefixLen) &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const deleteFrom = prefixLen;
  const deleteCount = oldStr.length - prefixLen - suffixLen;
  const insertEnd = suffixLen > 0 ? newStr.length - suffixLen : newStr.length;
  const insertText = newStr.slice(prefixLen, insertEnd);

  if (deleteCount > 0) {
    ytext.delete(deleteFrom, deleteCount);
  }
  if (insertText.length > 0) {
    ytext.insert(deleteFrom, insertText);
  }
}
