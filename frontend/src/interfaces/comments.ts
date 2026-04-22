/**
 * Comments capability + wire types for the frontend.
 *
 * These mirror the SPI types in `pkg/spi/comments_types.go`. Wire fields
 * stay `snake_case` so JSON parses directly; any camelCase aliases live
 * on view models, not on the wire layer.
 */

// --- Anchor + thread types ---

export interface CommentAnchor {
  start: number;
  end: number;
  quoted_text: string;
}

export interface Mention {
  user_id: string;
  display_name: string;
}

export interface Reaction {
  user_id: string;
  user_name: string;
  emoji: string;
  created_at: string;
}

export interface Comment {
  id: string;
  thread_id: string;
  author_id: string;
  author_name: string;
  content: string;
  mentions?: Mention[];
  reactions?: Reaction[];
  created_at: string;
  updated_at?: string;
  deleted_at?: string;
}

export type SuggestionStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'not_applicable';

export interface OperationSummary {
  kind: 'insert' | 'delete' | 'replace' | 'format';
  offset: number;
  length: number;
  inserted_text?: string;
  format_change?: string;
}

export interface SuggestionView {
  summary: string;
  before_text: string;
  after_text: string;
  operations: OperationSummary[];
}

export interface Suggestion {
  /** Opaque base64 Y.js update. Decoded only by the reviewer's editor. */
  yjs_payload: string;
  human_readable: SuggestionView;
  author_id: string;
  author_name: string;
  author_note?: string;
  status: SuggestionStatus;
  decided_by?: string;
  decided_at?: string;
  applied_version_id?: string;
}

export interface CommentThread {
  id: string;
  document_id: string;
  anchor: CommentAnchor;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
  comments: Comment[];
  reactions?: Reaction[];
  suggestion?: Suggestion;
}

export interface CommentThreadListEntry {
  id: string;
  anchor: CommentAnchor;
  status: 'open' | 'resolved';
  created_at: string;
  comment_count: number;
  last_author_name?: string;
  last_comment_at?: string;
  has_suggestion: boolean;
  suggestion_status?: SuggestionStatus;
}

export interface CommentsCapabilities {
  comment_edit: boolean;
  comment_delete: boolean;
  reactions: string[];
  mentions: boolean;
  suggestions: boolean;
  max_comment_size: number;
  poll_supported: boolean;
}

export interface MentionCandidate {
  user_id: string;
  display_name: string;
  avatar_url?: string;
}

export type CommentChangeAction =
  | 'created'
  | 'reply_added'
  | 'resolved'
  | 'reopened'
  | 'deleted'
  | 'suggestion_decided';

export interface CommentChange {
  thread_id: string;
  action: CommentChangeAction;
  by: string;
  at: string;
  comment_id?: string;
}

// --- Live (in-editor) view models layered on top of the wire types ---

/**
 * A committed suggestion overlay region. Start/end are character offsets
 * in the base Y.Text.
 */
export interface SuggestionOverlayRegion {
  threadId: string;
  start: number;
  end: number;
  afterText: string;
  operations: OperationSummary[];
  authorColor: string;
  status: SuggestionStatus;
}

// --- Binding capability interface ---

/**
 * Optional capability implemented by bindings that can render comment
 * decorations. Checked via `isCommentCapable()` at the call site.
 */
export interface ICommentCapability {
  enableComments(): void;
  disableComments(): void;
  /** Push fresh thread + overlay state to the editor's decoration plugin. */
  updateComments(
    threads: CommentThread[],
    overlays: SuggestionOverlayRegion[],
    activeThreadId: string | null,
  ): void;
}

export function isCommentCapable(binding: any): binding is ICommentCapability {
  return (
    binding !== null &&
    typeof binding === 'object' &&
    typeof binding.enableComments === 'function' &&
    typeof binding.disableComments === 'function' &&
    typeof binding.updateComments === 'function'
  );
}
