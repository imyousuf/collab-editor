/**
 * Comments SPI types. JSON wire fields use snake_case.
 *
 * Mirrors pkg/spi/comments_types.go exactly. Keep the two in sync.
 */

// --- Core thread & comment shapes ---

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

export interface CommentAnchor {
  start: number;
  end: number;
  quoted_text: string;
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

// --- Suggestions ---

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'not_applicable';

export interface Suggestion {
  /**
   * Opaque base64 Y.js update. The Comments Provider MUST NOT decode or
   * interpret this field — applying the payload on Accept is a
   * frontend-only concern.
   */
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

export interface SuggestionView {
  summary: string;
  before_text: string;
  after_text: string;
  operations: OperationSummary[];
}

export interface OperationSummary {
  kind: 'insert' | 'delete' | 'replace' | 'format';
  offset: number;
  length: number;
  inserted_text?: string;
  format_change?: string;
}

// --- List summaries & capabilities ---

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
  /** Allowed emoji set. Empty array = reactions disabled. */
  reactions: string[];
  mentions: boolean;
  suggestions: boolean;
  /** Byte cap on comment content. Default 10240. */
  max_comment_size: number;
  poll_supported: boolean;
}

// --- Polling ---

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

export interface CommentPollResponse {
  changes: CommentChange[];
  server_time: string;
}

// --- Request bodies ---

export interface NewComment {
  author_id: string;
  author_name: string;
  content: string;
  mentions?: Mention[];
}

export interface CreateCommentThreadRequest {
  anchor: CommentAnchor;
  comment?: NewComment;
  suggestion?: Suggestion;
}

export interface AddReplyRequest {
  author_id: string;
  author_name: string;
  content: string;
  mentions?: Mention[];
}

export interface UpdateThreadStatusRequest {
  status: 'open' | 'resolved';
  resolved_by?: string;
}

export interface UpdateCommentRequest {
  content: string;
  mentions?: Mention[];
  edited_by?: string;
}

export interface ReactionRequest {
  comment_id?: string;
  user_id: string;
  user_name: string;
  emoji: string;
}

export interface SuggestionDecisionRequest {
  decision: SuggestionStatus;
  decided_by: string;
  applied_version_id?: string;
}

export interface MentionCandidate {
  user_id: string;
  display_name: string;
  avatar_url?: string;
}
