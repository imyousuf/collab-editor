package spi

import "context"

// CommentsProvider is the interface that a Comments backend implements.
// It is independent from Provider (the Storage Provider) — a single binary
// may implement both, or each can be served by a separate service.
//
// The Comments SDK is Yjs-agnostic: a Suggestion's YjsPayload is stored as
// an opaque base64 string. Providers MUST NOT decode or interpret the
// payload. Applying it on Accept is a frontend-only concern.
type CommentsProvider interface {
	// Capabilities returns the set of features this provider supports.
	// Editor UI gates behavior on this response — see CommentsCapabilities.
	Capabilities(ctx context.Context) (*CommentsCapabilities, error)

	// ListCommentThreads returns lightweight thread summaries for a document.
	ListCommentThreads(ctx context.Context, documentID string) ([]CommentThreadListEntry, error)

	// GetCommentThread returns the full thread with comments, reactions,
	// and suggestion (if any).
	GetCommentThread(ctx context.Context, documentID string, threadID string) (*CommentThread, error)

	// CreateCommentThread creates a new thread. The request may include an
	// initial comment and/or an initial Suggestion.
	CreateCommentThread(ctx context.Context, documentID string, req *CreateCommentThreadRequest) (*CommentThread, error)

	// AddReply appends a reply to an existing thread.
	AddReply(ctx context.Context, documentID string, threadID string, req *AddReplyRequest) (*Comment, error)

	// UpdateThreadStatus resolves or reopens a thread.
	UpdateThreadStatus(ctx context.Context, documentID string, threadID string, req *UpdateThreadStatusRequest) (*CommentThread, error)

	// DeleteCommentThread removes a thread and all its comments.
	DeleteCommentThread(ctx context.Context, documentID string, threadID string) error
}

// OptionalCommentEdit lets providers expose per-comment edit/delete.
// When unimplemented, the corresponding HTTP routes are NOT registered,
// and the editor hides the relevant UI via the Capabilities response.
type OptionalCommentEdit interface {
	UpdateComment(ctx context.Context, documentID, threadID, commentID string, req *UpdateCommentRequest) (*Comment, error)
	DeleteComment(ctx context.Context, documentID, threadID, commentID string) error
}

// OptionalReactions lets providers support emoji reactions on threads/comments.
// The set of allowed emojis is declared via CommentsCapabilities.Reactions.
type OptionalReactions interface {
	AddReaction(ctx context.Context, documentID, threadID string, req *ReactionRequest) error
	RemoveReaction(ctx context.Context, documentID, threadID string, req *ReactionRequest) error
}

// OptionalSuggestions lets providers record accept/reject decisions on
// suggestions. The yjs_payload field remains opaque to the provider;
// only the status/audit fields are touched here.
type OptionalSuggestions interface {
	DecideSuggestion(ctx context.Context, documentID, threadID string, req *SuggestionDecisionRequest) (*CommentThread, error)
}

// OptionalMentions lets providers expose an @-mention search endpoint.
// The provider returns candidates from its user directory (LDAP, DB, etc.).
type OptionalMentions interface {
	SearchMentions(ctx context.Context, documentID, query string, limit int) ([]MentionCandidate, error)
}

// OptionalCommentPoll lets providers support external-change polling so
// that modifications made outside the editor (e.g., resolved from chat)
// are detected and replayed into the live Y.Doc.
type OptionalCommentPoll interface {
	PollCommentChanges(ctx context.Context, documentID string, since string) (*CommentPollResponse, error)
}
