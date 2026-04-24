/**
 * Suggest Mode capability + payload types for the frontend.
 */

import type {
  CommentAnchor,
  OperationSummary,
  SuggestionView,
} from './comments.js';

/**
 * The complete payload produced by the SuggestEngine when the user commits
 * a suggestion. Contains both the opaque Y.js update and a human-readable
 * view. Passed to the CommentEngine which writes it into Y.Map("comments")
 * and (debounced) persists to the Comments provider.
 */
export interface SuggestionPayload {
  anchor: CommentAnchor;
  /**
   * Base64 Y.js update — opaque outside of the editor.
   * Legacy field: new submissions omit this (Accept applies a text-level
   * diff to syncText instead). Retained for backward compatibility with
   * threads created before the syncDoc/editorDoc split.
   */
  yjs_payload?: string;
  view: SuggestionView;
  /** Optional markdown note from the author explaining the change. */
  author_note: string | null;
}

/**
 * Live, not-yet-committed overlay region rendered while Suggest Mode is on.
 * Identical shape to SuggestionOverlayRegion except no thread id yet.
 */
export interface PendingSuggestOverlay {
  start: number;
  end: number;
  afterText: string;
  operations: OperationSummary[];
  authorColor: string;
}

/**
 * Optional capability implemented by bindings that can route editor writes
 * into a local Suggest buffer rather than the shared Y.Text. Checked via
 * `isSuggestCapable()` at the call site.
 */
export interface ISuggestCapability {
  /**
   * Enter Suggest Mode. The binding should divert local writes into the
   * provided buffer Y.Text / Y.Doc. Remote updates to the base Y.Text
   * still apply normally.
   */
  enableSuggest(bufferText: any, bufferDoc: any): void;

  /** Leave Suggest Mode, restore binding to the base Y.Text. */
  disableSuggest(): void;

  /** Whether the binding is currently diverting writes to the buffer. */
  isSuggestActive(): boolean;

  /** Push a fresh pending overlay to the decoration plugin. */
  updatePendingOverlay(overlay: PendingSuggestOverlay | null): void;
}

export function isSuggestCapable(binding: any): binding is ISuggestCapability {
  return (
    binding !== null &&
    typeof binding === 'object' &&
    typeof binding.enableSuggest === 'function' &&
    typeof binding.disableSuggest === 'function' &&
    typeof binding.isSuggestActive === 'function' &&
    typeof binding.updatePendingOverlay === 'function'
  );
}

/**
 * Warning emitted by SuggestEngine when a remote edit to the base Y.Text
 * invalidates part of a pending buffer (e.g., the range being edited was
 * concurrently deleted by another peer).
 */
export interface SuggestRebaseWarning {
  message: string;
  droppedOperations: number;
}
