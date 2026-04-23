"""Dataclasses mirroring pkg/spi/comments_types.go.

Wire JSON is snake_case; these dataclasses already match.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

SuggestionStatus = Literal["pending", "accepted", "rejected", "not_applicable"]
CommentChangeAction = Literal[
    "created", "reply_added", "resolved", "reopened", "deleted", "suggestion_decided"
]


@dataclass
class CommentAnchor:
    start: int
    end: int
    quoted_text: str


@dataclass
class Mention:
    user_id: str
    display_name: str


@dataclass
class Reaction:
    user_id: str
    user_name: str
    emoji: str
    created_at: str


@dataclass
class OperationSummary:
    kind: str  # "insert" | "delete" | "replace" | "format"
    offset: int
    length: int
    inserted_text: Optional[str] = None
    format_change: Optional[str] = None


@dataclass
class SuggestionView:
    summary: str
    before_text: str
    after_text: str
    operations: list[OperationSummary] = field(default_factory=list)


@dataclass
class Suggestion:
    """Proposed edit attached to a comment thread.

    ``yjs_payload`` is an opaque base64 Y.js update. The provider MUST NOT
    decode or interpret it -- applying the payload on Accept is a
    frontend-only concern.
    """

    yjs_payload: str
    human_readable: SuggestionView
    author_id: str
    author_name: str
    status: SuggestionStatus = "pending"
    author_note: Optional[str] = None
    decided_by: Optional[str] = None
    decided_at: Optional[str] = None
    applied_version_id: Optional[str] = None


@dataclass
class Comment:
    id: str
    thread_id: str
    author_id: str
    author_name: str
    content: str
    created_at: str
    mentions: list[Mention] = field(default_factory=list)
    reactions: list[Reaction] = field(default_factory=list)
    updated_at: Optional[str] = None
    deleted_at: Optional[str] = None


@dataclass
class CommentThread:
    id: str
    document_id: str
    anchor: CommentAnchor
    status: Literal["open", "resolved"]
    created_at: str
    comments: list[Comment] = field(default_factory=list)
    reactions: list[Reaction] = field(default_factory=list)
    resolved_at: Optional[str] = None
    resolved_by: Optional[str] = None
    suggestion: Optional[Suggestion] = None


@dataclass
class CommentThreadListEntry:
    id: str
    anchor: CommentAnchor
    status: Literal["open", "resolved"]
    created_at: str
    comment_count: int = 0
    has_suggestion: bool = False
    last_author_name: Optional[str] = None
    last_comment_at: Optional[str] = None
    suggestion_status: Optional[SuggestionStatus] = None


@dataclass
class CommentsCapabilities:
    comment_edit: bool = False
    comment_delete: bool = False
    reactions: list[str] = field(default_factory=list)  # empty = disabled
    mentions: bool = False
    suggestions: bool = False
    max_comment_size: int = 10240
    poll_supported: bool = False


@dataclass
class CommentChange:
    thread_id: str
    action: CommentChangeAction
    by: str
    at: str
    comment_id: Optional[str] = None


@dataclass
class CommentPollResponse:
    changes: list[CommentChange] = field(default_factory=list)
    server_time: str = ""


# --- Request bodies ---


@dataclass
class NewComment:
    # Client-supplied identifier. REQUIRED: the collaborative editor
    # treats its local Y.Map IDs as authoritative; providers must persist
    # under the given ID (no server-side generation) and return 409 on
    # collision.
    id: str
    author_id: str
    author_name: str
    content: str
    mentions: list[Mention] = field(default_factory=list)


@dataclass
class CreateCommentThreadRequest:
    id: str
    anchor: CommentAnchor
    comment: Optional[NewComment] = None
    suggestion: Optional[Suggestion] = None


@dataclass
class AddReplyRequest:
    id: str
    author_id: str
    author_name: str
    content: str
    mentions: list[Mention] = field(default_factory=list)


@dataclass
class UpdateThreadStatusRequest:
    status: Literal["open", "resolved"]
    resolved_by: Optional[str] = None


@dataclass
class UpdateCommentRequest:
    content: str
    mentions: list[Mention] = field(default_factory=list)
    edited_by: Optional[str] = None


@dataclass
class ReactionRequest:
    user_id: str
    user_name: str
    emoji: str
    comment_id: Optional[str] = None


@dataclass
class SuggestionDecisionRequest:
    decision: SuggestionStatus
    decided_by: str
    applied_version_id: Optional[str] = None


@dataclass
class MentionCandidate:
    user_id: str
    display_name: str
    avatar_url: Optional[str] = None
