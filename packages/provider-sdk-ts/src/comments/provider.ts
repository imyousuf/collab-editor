/**
 * CommentsProvider interface — parallel to Provider (Storage SDK).
 * Unlike Storage, there is NO Yjs engine here. Suggestion payloads flow
 * through as opaque base64 strings.
 */
import type {
  AddReplyRequest,
  Comment,
  CommentPollResponse,
  CommentThread,
  CommentThreadListEntry,
  CommentsCapabilities,
  CreateCommentThreadRequest,
  MentionCandidate,
  ReactionRequest,
  SuggestionDecisionRequest,
  UpdateCommentRequest,
  UpdateThreadStatusRequest,
} from './types.js';

/**
 * Base interface every Comments Provider must implement.
 *
 * Optional features (comment edit/delete, reactions, suggestions decisions,
 * mentions search, polling) are declared by adding the corresponding
 * optional methods on the same object. The HTTP handler factory
 * conditionally registers routes based on method presence; the Capabilities
 * response tells the client which features are actually available.
 */
export interface CommentsProvider {
  capabilities(): Promise<CommentsCapabilities>;

  listCommentThreads(documentId: string): Promise<CommentThreadListEntry[]>;
  getCommentThread(documentId: string, threadId: string): Promise<CommentThread | null>;
  createCommentThread(
    documentId: string,
    req: CreateCommentThreadRequest,
  ): Promise<CommentThread>;
  addReply(
    documentId: string,
    threadId: string,
    req: AddReplyRequest,
  ): Promise<Comment>;
  updateThreadStatus(
    documentId: string,
    threadId: string,
    req: UpdateThreadStatusRequest,
  ): Promise<CommentThread>;
  deleteCommentThread(documentId: string, threadId: string): Promise<void>;

  // --- Optional extensions (presence controls route registration) ---

  /** Per-comment edit. Paired with deleteComment. */
  updateComment?(
    documentId: string,
    threadId: string,
    commentId: string,
    req: UpdateCommentRequest,
  ): Promise<Comment>;

  deleteComment?(
    documentId: string,
    threadId: string,
    commentId: string,
  ): Promise<void>;

  /** Add/remove emoji reactions. Allowed emoji set declared via capabilities. */
  addReaction?(
    documentId: string,
    threadId: string,
    req: ReactionRequest,
  ): Promise<void>;

  removeReaction?(
    documentId: string,
    threadId: string,
    req: ReactionRequest,
  ): Promise<void>;

  /** Accept/reject a suggestion. yjs_payload remains opaque. */
  decideSuggestion?(
    documentId: string,
    threadId: string,
    req: SuggestionDecisionRequest,
  ): Promise<CommentThread>;

  /** @-mention search over the user directory. */
  searchMentions?(
    documentId: string,
    query: string,
    limit: number,
  ): Promise<MentionCandidate[]>;

  /** Return changes since the given ISO timestamp (for external integrations). */
  pollCommentChanges?(
    documentId: string,
    since: string,
  ): Promise<CommentPollResponse>;
}
