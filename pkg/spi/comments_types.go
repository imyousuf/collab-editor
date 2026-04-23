package spi

import (
	"errors"
	"time"
)

// ErrCommentThreadExists is returned by CreateCommentThread when the
// client-supplied ID already exists. The HTTP handler maps it to 409
// Conflict so the client can decide whether to retry with a fresh ID or
// reconcile against the existing thread.
var ErrCommentThreadExists = errors.New("comment thread id already exists")

// ErrCommentIDRequired is returned when a create or reply request omits
// its required client-supplied ID (CreateCommentThreadRequest.ID,
// NewComment.ID, AddReplyRequest.ID). The HTTP handler maps it to 400
// Bad Request. Clients MUST always send IDs so the server persists
// under the same key the client tracks in its Y.Map.
var ErrCommentIDRequired = errors.New("id is required")

// --- Comments core types ---

// CommentThread is a threaded discussion anchored to a range of text in a document.
// A thread may also carry an optional Suggestion — a proposed edit to the anchored range.
type CommentThread struct {
	ID         string        `json:"id"`
	DocumentID string        `json:"document_id"`
	Anchor     CommentAnchor `json:"anchor"`
	Status     string        `json:"status"` // "open" | "resolved"
	CreatedAt  time.Time     `json:"created_at"`
	ResolvedAt *time.Time    `json:"resolved_at,omitempty"`
	ResolvedBy string        `json:"resolved_by,omitempty"`
	Comments   []Comment     `json:"comments"`
	Reactions  []Reaction    `json:"reactions,omitempty"`
	Suggestion *Suggestion   `json:"suggestion,omitempty"`
}

// CommentAnchor pins a thread to a character range in the document's Y.Text.
// Storage is Yjs-agnostic — start/end are plain character offsets, quoted_text
// is the selected text at creation time so anchors can fuzzy-match if the
// document changes before the editor re-resolves.
type CommentAnchor struct {
	Start      int    `json:"start"`       // character offset (inclusive)
	End        int    `json:"end"`         // character offset (exclusive)
	QuotedText string `json:"quoted_text"` // selected text at creation time
}

// Comment is a single message inside a thread.
type Comment struct {
	ID         string     `json:"id"`
	ThreadID   string     `json:"thread_id"`
	AuthorID   string     `json:"author_id"`
	AuthorName string     `json:"author_name"`
	Content    string     `json:"content"` // markdown, max 10 KB by default
	Mentions   []Mention  `json:"mentions,omitempty"`
	Reactions  []Reaction `json:"reactions,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  *time.Time `json:"updated_at,omitempty"`
	DeletedAt  *time.Time `json:"deleted_at,omitempty"` // soft delete
}

// Mention records a user referenced inside a comment body via the
// "@[Display Name](user-id)" inline token. The SDK extracts mentions on
// write so downstream notification systems don't have to re-parse markdown.
type Mention struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
}

// Reaction is a (user, emoji) pair on a thread or a comment.
// The allowed emoji set is declared by the provider via Capabilities.
type Reaction struct {
	UserID    string    `json:"user_id"`
	UserName  string    `json:"user_name"`
	Emoji     string    `json:"emoji"`
	CreatedAt time.Time `json:"created_at"`
}

// --- Suggestions ---

// Suggestion is an optional proposed edit attached to a thread.
// YjsPayload is an opaque base64 string carrying the Y.js operations that
// would be applied to the document on Accept. The provider MUST NOT decode
// or interpret this field — it is a frontend-only concern.
type Suggestion struct {
	YjsPayload       string         `json:"yjs_payload"`
	HumanReadable    SuggestionView `json:"human_readable"`
	AuthorID         string         `json:"author_id"`
	AuthorName       string         `json:"author_name"`
	AuthorNote       string         `json:"author_note,omitempty"` // optional markdown comment from author
	Status           string         `json:"status"`                // "pending" | "accepted" | "rejected" | "not_applicable"
	DecidedBy        string         `json:"decided_by,omitempty"`
	DecidedAt        *time.Time     `json:"decided_at,omitempty"`
	AppliedVersionID string         `json:"applied_version_id,omitempty"`
}

// SuggestionView is the human-readable, Yjs-free representation of a suggestion.
// Integrations that don't run a Y.js engine (e.g., a chat/IM bridge) consume
// this view to render the change to users.
type SuggestionView struct {
	Summary    string             `json:"summary"`
	BeforeText string             `json:"before_text"` // same as anchor.quoted_text at creation
	AfterText  string             `json:"after_text"`  // post-suggestion text, same MIME as doc
	Operations []OperationSummary `json:"operations"`
}

// OperationSummary is a structured description of a single change within a
// suggestion, used for UI diff rendering.
type OperationSummary struct {
	Kind          string `json:"kind"`                     // "insert" | "delete" | "replace" | "format"
	Offset        int    `json:"offset"`                   // offset in the original document
	Length        int    `json:"length"`                   // characters affected in the original
	InsertedText  string `json:"inserted_text,omitempty"`  // for insert/replace
	FormatChange  string `json:"format_change,omitempty"`  // e.g., "bold:on", "heading:2→3"
}

// --- Thread list + capabilities ---

// CommentThreadListEntry is a lightweight thread summary returned by the
// list endpoint. Omits the full comment bodies + suggestion payload.
type CommentThreadListEntry struct {
	ID                string     `json:"id"`
	Anchor            CommentAnchor `json:"anchor"`
	Status            string     `json:"status"`
	CreatedAt         time.Time  `json:"created_at"`
	CommentCount      int        `json:"comment_count"`
	LastAuthorName    string     `json:"last_author_name,omitempty"`
	LastCommentAt     *time.Time `json:"last_comment_at,omitempty"`
	HasSuggestion     bool       `json:"has_suggestion"`
	SuggestionStatus  string     `json:"suggestion_status,omitempty"`
}

// CommentsCapabilities declares which features the Comments Provider supports.
// The editor fetches this once on connect and adapts its UI accordingly —
// features that are off produce no buttons, no keyboard shortcuts, and no SPI calls.
type CommentsCapabilities struct {
	CommentEdit    bool     `json:"comment_edit"`
	CommentDelete  bool     `json:"comment_delete"`
	Reactions      []string `json:"reactions"`        // allowed emoji; empty = reactions disabled
	Mentions       bool     `json:"mentions"`
	Suggestions    bool     `json:"suggestions"`
	MaxCommentSize int      `json:"max_comment_size"` // bytes; default 10240
	PollSupported  bool     `json:"poll_supported"`
}

// --- Polling ---

// CommentChange describes a single change event returned by the poll endpoint.
// Used by external integrations to pick up modifications made outside the editor.
type CommentChange struct {
	ThreadID  string    `json:"thread_id"`
	Action    string    `json:"action"` // "created" | "reply_added" | "resolved" | "reopened" | "deleted" | "suggestion_decided"
	By        string    `json:"by"`
	At        time.Time `json:"at"`
	CommentID string    `json:"comment_id,omitempty"` // for "reply_added"
}

// CommentPollResponse is returned by the poll endpoint.
type CommentPollResponse struct {
	Changes    []CommentChange `json:"changes"`
	ServerTime time.Time       `json:"server_time"`
}

// --- Request bodies ---

// CreateCommentThreadRequest is the body sent to create a new thread.
// A single comment (or initial author note for suggestion-carrying threads)
// can be included with the thread creation request.
//
// ID is the authoritative identifier for the thread and is REQUIRED. The
// collaborative frontend tracks threads in a Y.Map keyed by this ID;
// RelativePosition anchors, resolve/reopen PATCHes, and decoration
// lookups all depend on it being stable across the wire. A provider-
// generated ID would diverge from the Y.Map key and silently drop
// resolve PATCHes (historic bug). Providers MUST store the thread under
// the client-supplied ID and return 409 if the ID is already in use.
type CreateCommentThreadRequest struct {
	ID         string        `json:"id"`
	Anchor     CommentAnchor `json:"anchor"`
	Comment    *NewComment   `json:"comment,omitempty"`    // optional initial comment
	Suggestion *Suggestion   `json:"suggestion,omitempty"` // optional suggested edit
}

// NewComment carries the content + authorship for a new comment or reply.
// Mentions are extracted from content by the SDK but may be supplied by the
// caller to avoid re-parsing. ID is REQUIRED for the same reason as
// CreateCommentThreadRequest.ID: Y.Map keys are authoritative.
type NewComment struct {
	ID         string    `json:"id"`
	AuthorID   string    `json:"author_id"`
	AuthorName string    `json:"author_name"`
	Content    string    `json:"content"`
	Mentions   []Mention `json:"mentions,omitempty"`
}

// AddReplyRequest is the body sent to POST /documents/comments/{threadId}/replies.
// ID is the client-supplied comment identifier; REQUIRED.
type AddReplyRequest struct {
	ID         string    `json:"id"`
	AuthorID   string    `json:"author_id"`
	AuthorName string    `json:"author_name"`
	Content    string    `json:"content"`
	Mentions   []Mention `json:"mentions,omitempty"`
}

// UpdateThreadStatusRequest is the body sent to PATCH /documents/comments/{threadId}.
type UpdateThreadStatusRequest struct {
	Status     string `json:"status"` // "open" | "resolved"
	ResolvedBy string `json:"resolved_by,omitempty"`
}

// UpdateCommentRequest is the body sent to PATCH an individual comment.
type UpdateCommentRequest struct {
	Content  string    `json:"content"`
	Mentions []Mention `json:"mentions,omitempty"`
	EditedBy string    `json:"edited_by,omitempty"`
}

// ReactionRequest is the body sent to add/remove a reaction on a thread or comment.
// If CommentID is empty, the reaction targets the thread root; otherwise it
// targets the specific comment within the thread.
type ReactionRequest struct {
	CommentID string `json:"comment_id,omitempty"`
	UserID    string `json:"user_id"`
	UserName  string `json:"user_name"`
	Emoji     string `json:"emoji"`
}

// SuggestionDecisionRequest is the body sent to record an accept/reject decision.
// AppliedVersionID is populated by the client when a version was created as a
// result of applying the suggestion (accept case).
type SuggestionDecisionRequest struct {
	Decision         string `json:"decision"` // "accepted" | "rejected" | "not_applicable"
	DecidedBy        string `json:"decided_by"`
	AppliedVersionID string `json:"applied_version_id,omitempty"`
}

// MentionCandidate is a single result from the mentions search endpoint.
type MentionCandidate struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}
