"""Comments SDK — separate from the Storage Provider.

Provides the CommentsProvider ABC and a FastAPI router factory. The SDK is
Yjs-agnostic: suggestion payloads are stored as opaque base64 strings.
"""

from .types import (
    AddReplyRequest,
    Comment,
    CommentAnchor,
    CommentChange,
    CommentPollResponse,
    CommentThread,
    CommentThreadListEntry,
    CommentsCapabilities,
    CreateCommentThreadRequest,
    Mention,
    MentionCandidate,
    NewComment,
    OperationSummary,
    Reaction,
    ReactionRequest,
    Suggestion,
    SuggestionDecisionRequest,
    SuggestionView,
    UpdateCommentRequest,
    UpdateThreadStatusRequest,
)
from .provider import CommentsProvider
from .handler import create_comments_fastapi_router

__all__ = [
    "CommentThread",
    "CommentAnchor",
    "Comment",
    "Mention",
    "Reaction",
    "Suggestion",
    "SuggestionView",
    "OperationSummary",
    "CommentThreadListEntry",
    "CommentsCapabilities",
    "CommentChange",
    "CommentPollResponse",
    "NewComment",
    "CreateCommentThreadRequest",
    "AddReplyRequest",
    "UpdateThreadStatusRequest",
    "UpdateCommentRequest",
    "ReactionRequest",
    "SuggestionDecisionRequest",
    "MentionCandidate",
    "CommentsProvider",
    "create_comments_fastapi_router",
]
