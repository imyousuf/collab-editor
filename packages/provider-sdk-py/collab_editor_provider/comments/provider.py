"""CommentsProvider ABC.

Mirrors the Go ``spi.CommentsProvider`` interface. Optional features are
detected via ``supports_*`` properties (same pattern as the Storage SDK's
``Provider.supports_*``). The HTTP handler factory uses these to decide
which routes to register.

The SDK has no Yjs dependency. Suggestion payloads (``yjs_payload``) are
stored opaquely and flow through the handler untouched.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from .types import (
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
)


class CommentsProvider(ABC):
    """Interface a Comments backend implements.

    Base methods are required. Optional methods (:meth:`update_comment`,
    :meth:`delete_comment`, :meth:`add_reaction`, :meth:`remove_reaction`,
    :meth:`decide_suggestion`, :meth:`search_mentions`,
    :meth:`poll_comment_changes`) are opt-in; override what you support and
    expose the capability via :meth:`capabilities`.
    """

    # --- Required ---

    @abstractmethod
    async def capabilities(self) -> CommentsCapabilities:
        """Return the feature matrix the editor should gate UI on."""
        ...

    @abstractmethod
    async def list_comment_threads(
        self, document_id: str
    ) -> list[CommentThreadListEntry]:
        ...

    @abstractmethod
    async def get_comment_thread(
        self, document_id: str, thread_id: str
    ) -> Optional[CommentThread]:
        ...

    @abstractmethod
    async def create_comment_thread(
        self, document_id: str, req: CreateCommentThreadRequest
    ) -> CommentThread:
        ...

    @abstractmethod
    async def add_reply(
        self, document_id: str, thread_id: str, req: AddReplyRequest
    ) -> Comment:
        ...

    @abstractmethod
    async def update_thread_status(
        self, document_id: str, thread_id: str, req: UpdateThreadStatusRequest
    ) -> CommentThread:
        ...

    @abstractmethod
    async def delete_comment_thread(self, document_id: str, thread_id: str) -> None:
        ...

    # --- Optional ---

    async def update_comment(
        self,
        document_id: str,
        thread_id: str,
        comment_id: str,
        req: UpdateCommentRequest,
    ) -> Comment:
        raise NotImplementedError

    async def delete_comment(
        self, document_id: str, thread_id: str, comment_id: str
    ) -> None:
        raise NotImplementedError

    async def add_reaction(
        self, document_id: str, thread_id: str, req: ReactionRequest
    ) -> None:
        raise NotImplementedError

    async def remove_reaction(
        self, document_id: str, thread_id: str, req: ReactionRequest
    ) -> None:
        raise NotImplementedError

    async def decide_suggestion(
        self, document_id: str, thread_id: str, req: SuggestionDecisionRequest
    ) -> CommentThread:
        raise NotImplementedError

    async def search_mentions(
        self, document_id: str, query: str, limit: int
    ) -> list[MentionCandidate]:
        raise NotImplementedError

    async def poll_comment_changes(
        self, document_id: str, since: str
    ) -> CommentPollResponse:
        raise NotImplementedError

    # --- Capability detection via method overrides ---

    @property
    def supports_comment_edit(self) -> bool:
        return (
            type(self).update_comment is not CommentsProvider.update_comment
            and type(self).delete_comment is not CommentsProvider.delete_comment
        )

    @property
    def supports_reactions(self) -> bool:
        return (
            type(self).add_reaction is not CommentsProvider.add_reaction
            and type(self).remove_reaction is not CommentsProvider.remove_reaction
        )

    @property
    def supports_suggestions(self) -> bool:
        return type(self).decide_suggestion is not CommentsProvider.decide_suggestion

    @property
    def supports_mentions(self) -> bool:
        return type(self).search_mentions is not CommentsProvider.search_mentions

    @property
    def supports_poll(self) -> bool:
        return (
            type(self).poll_comment_changes
            is not CommentsProvider.poll_comment_changes
        )
