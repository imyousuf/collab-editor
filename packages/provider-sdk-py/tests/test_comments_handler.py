"""Tests for create_comments_fastapi_router."""

from __future__ import annotations

from typing import Optional

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from collab_editor_provider.comments import (
    AddReplyRequest,
    Comment,
    CommentAnchor,
    CommentChange,
    CommentPollResponse,
    CommentThread,
    CommentThreadListEntry,
    CommentsCapabilities,
    CommentsProvider,
    CreateCommentThreadRequest,
    MentionCandidate,
    ReactionRequest,
    Suggestion,
    SuggestionDecisionRequest,
    UpdateCommentRequest,
    UpdateThreadStatusRequest,
    create_comments_fastapi_router,
)


class CoreProvider(CommentsProvider):
    """Implements only the required interface — no optional features."""

    def __init__(self) -> None:
        self.threads: dict[str, CommentThread] = {}
        self._next_id = 0

    async def capabilities(self) -> CommentsCapabilities:
        return CommentsCapabilities(
            comment_edit=False,
            comment_delete=False,
            reactions=[],
            mentions=False,
            suggestions=False,
            max_comment_size=10240,
            poll_supported=False,
        )

    async def list_comment_threads(
        self, document_id: str
    ) -> list[CommentThreadListEntry]:
        return [
            CommentThreadListEntry(
                id=t.id,
                anchor=t.anchor,
                status=t.status,
                created_at=t.created_at,
                comment_count=len(t.comments),
                has_suggestion=t.suggestion is not None,
                suggestion_status=t.suggestion.status if t.suggestion else None,
            )
            for t in self.threads.values()
        ]

    async def get_comment_thread(
        self, document_id: str, thread_id: str
    ) -> Optional[CommentThread]:
        return self.threads.get(thread_id)

    async def create_comment_thread(
        self, document_id: str, req: CreateCommentThreadRequest
    ) -> CommentThread:
        self._next_id += 1
        tid = f"t{self._next_id}"
        comments: list[Comment] = []
        if req.comment:
            comments.append(
                Comment(
                    id=f"{tid}-c1",
                    thread_id=tid,
                    author_id=req.comment.author_id,
                    author_name=req.comment.author_name,
                    content=req.comment.content,
                    created_at="2026-01-01T00:00:00Z",
                    mentions=req.comment.mentions,
                )
            )
        thread = CommentThread(
            id=tid,
            document_id=document_id,
            anchor=req.anchor,
            status="open",
            created_at="2026-01-01T00:00:00Z",
            comments=comments,
            suggestion=req.suggestion,
        )
        self.threads[tid] = thread
        return thread

    async def add_reply(
        self, document_id: str, thread_id: str, req: AddReplyRequest
    ) -> Comment:
        thread = self.threads[thread_id]
        comment = Comment(
            id=f"{thread_id}-c{len(thread.comments) + 1}",
            thread_id=thread_id,
            author_id=req.author_id,
            author_name=req.author_name,
            content=req.content,
            created_at="2026-01-01T00:00:00Z",
            mentions=req.mentions,
        )
        thread.comments.append(comment)
        return comment

    async def update_thread_status(
        self,
        document_id: str,
        thread_id: str,
        req: UpdateThreadStatusRequest,
    ) -> CommentThread:
        thread = self.threads[thread_id]
        thread.status = req.status
        if req.status == "resolved":
            thread.resolved_at = "2026-01-01T00:00:00Z"
            thread.resolved_by = req.resolved_by
        return thread

    async def delete_comment_thread(
        self, document_id: str, thread_id: str
    ) -> None:
        self.threads.pop(thread_id, None)


class FullProvider(CoreProvider):
    """Implements every optional feature. Used for the gating tests."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[str] = []

    async def capabilities(self) -> CommentsCapabilities:
        return CommentsCapabilities(
            comment_edit=True,
            comment_delete=True,
            reactions=["thumbsup", "heart", "laugh"],
            mentions=True,
            suggestions=True,
            max_comment_size=10240,
            poll_supported=True,
        )

    async def update_comment(
        self,
        document_id: str,
        thread_id: str,
        comment_id: str,
        req: UpdateCommentRequest,
    ) -> Comment:
        self.calls.append("update_comment")
        return Comment(
            id=comment_id,
            thread_id=thread_id,
            author_id="u1",
            author_name="Alice",
            content=req.content,
            created_at="2026-01-01T00:00:00Z",
        )

    async def delete_comment(
        self, document_id: str, thread_id: str, comment_id: str
    ) -> None:
        self.calls.append("delete_comment")

    async def add_reaction(
        self, document_id: str, thread_id: str, req: ReactionRequest
    ) -> None:
        self.calls.append(f"add_reaction:{req.emoji}")

    async def remove_reaction(
        self, document_id: str, thread_id: str, req: ReactionRequest
    ) -> None:
        self.calls.append(f"remove_reaction:{req.emoji}")

    async def decide_suggestion(
        self,
        document_id: str,
        thread_id: str,
        req: SuggestionDecisionRequest,
    ) -> CommentThread:
        self.calls.append(f"decide:{req.decision}")
        thread = self.threads.get(thread_id)
        if thread is None:
            thread = CommentThread(
                id=thread_id,
                document_id=document_id,
                anchor=CommentAnchor(start=0, end=1, quoted_text="a"),
                status="resolved",
                created_at="2026-01-01T00:00:00Z",
            )
            self.threads[thread_id] = thread
        if thread.suggestion:
            thread.suggestion.status = req.decision  # type: ignore[assignment]
        thread.status = "resolved"
        return thread

    async def search_mentions(
        self, document_id: str, query: str, limit: int
    ) -> list[MentionCandidate]:
        self.calls.append(f"search:{query}:{limit}")
        return [MentionCandidate(user_id="u1", display_name="Alice")]

    async def poll_comment_changes(
        self, document_id: str, since: str
    ) -> CommentPollResponse:
        self.calls.append(f"poll:{since}")
        return CommentPollResponse(
            changes=[
                CommentChange(
                    thread_id="t1",
                    action="resolved",
                    by="u1",
                    at="2026-01-01T00:00:00Z",
                )
            ],
            server_time="2026-01-01T00:00:00Z",
        )


@pytest.fixture
def core_provider() -> CoreProvider:
    return CoreProvider()


@pytest.fixture
def full_provider() -> FullProvider:
    return FullProvider()


def make_app(provider: CommentsProvider) -> FastAPI:
    app = FastAPI()
    app.include_router(create_comments_fastapi_router(provider))
    return app


@pytest.fixture
async def core_client(core_provider: CoreProvider):
    transport = ASGITransport(app=make_app(core_provider))
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def full_client(full_provider: FullProvider):
    transport = ASGITransport(app=make_app(full_provider))
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestCore:
    async def test_capabilities(self, core_client: AsyncClient) -> None:
        resp = await core_client.get("/capabilities")
        assert resp.status_code == 200
        body = resp.json()
        assert body["reactions"] == []
        assert body["mentions"] is False
        assert body["suggestions"] is False

    async def test_create_and_get_thread(
        self, core_provider: CoreProvider, core_client: AsyncClient
    ) -> None:
        create = await core_client.post(
            "/documents/comments?path=doc.md",
            json={
                "anchor": {"start": 0, "end": 5, "quoted_text": "hello"},
                "comment": {
                    "author_id": "u1",
                    "author_name": "Alice",
                    "content": "first",
                },
            },
        )
        assert create.status_code == 201
        tid = create.json()["id"]

        get = await core_client.get(f"/documents/comments/{tid}?path=doc.md")
        assert get.status_code == 200
        assert get.json()["comments"][0]["content"] == "first"

    async def test_get_thread_not_found(self, core_client: AsyncClient) -> None:
        resp = await core_client.get("/documents/comments/missing?path=doc.md")
        assert resp.status_code == 404

    async def test_list_threads(
        self, core_provider: CoreProvider, core_client: AsyncClient
    ) -> None:
        await core_client.post(
            "/documents/comments?path=doc.md",
            json={"anchor": {"start": 0, "end": 1, "quoted_text": "a"}},
        )
        list_resp = await core_client.get("/documents/comments?path=doc.md")
        assert list_resp.status_code == 200
        assert len(list_resp.json()["threads"]) == 1

    async def test_add_reply(self, core_client: AsyncClient) -> None:
        create = await core_client.post(
            "/documents/comments?path=doc.md",
            json={"anchor": {"start": 0, "end": 1, "quoted_text": "a"}},
        )
        tid = create.json()["id"]

        reply = await core_client.post(
            f"/documents/comments/{tid}/replies?path=doc.md",
            json={"author_id": "u2", "author_name": "Bob", "content": "ack"},
        )
        assert reply.status_code == 201
        assert reply.json()["content"] == "ack"

    async def test_patch_and_delete(self, core_client: AsyncClient) -> None:
        create = await core_client.post(
            "/documents/comments?path=doc.md",
            json={"anchor": {"start": 0, "end": 1, "quoted_text": "a"}},
        )
        tid = create.json()["id"]

        patch = await core_client.patch(
            f"/documents/comments/{tid}?path=doc.md",
            json={"status": "resolved", "resolved_by": "u1"},
        )
        assert patch.status_code == 200
        assert patch.json()["status"] == "resolved"

        delete = await core_client.delete(f"/documents/comments/{tid}?path=doc.md")
        assert delete.status_code == 204


class TestOptionalGating:
    async def test_core_provider_hides_optional_routes(
        self, core_client: AsyncClient
    ) -> None:
        # Each optional route should be missing on a core-only provider.
        missing_paths = [
            ("POST", "/documents/comments/t1/reactions?path=doc.md"),
            ("DELETE", "/documents/comments/t1/reactions?path=doc.md"),
            ("POST", "/documents/comments/t1/suggestion/decision?path=doc.md"),
            ("GET", "/documents/comments/mentions/search?path=doc.md&q=ali"),
            ("GET", "/documents/comments/poll?path=doc.md&since=2020-01-01"),
            ("PATCH", "/documents/comments/t1/comments/c1?path=doc.md"),
            ("DELETE", "/documents/comments/t1/comments/c1?path=doc.md"),
        ]
        for method, url in missing_paths:
            resp = await core_client.request(method, url, json={})
            assert resp.status_code in (404, 405), f"{method} {url} -> {resp.status_code}"

    async def test_full_provider_routes_all_call_through(
        self, full_provider: FullProvider, full_client: AsyncClient
    ) -> None:
        # Edit + delete
        r = await full_client.patch(
            "/documents/comments/t1/comments/c1?path=doc.md",
            json={"content": "edited"},
        )
        assert r.status_code == 200
        r = await full_client.delete("/documents/comments/t1/comments/c1?path=doc.md")
        assert r.status_code == 204

        # Reactions
        r = await full_client.post(
            "/documents/comments/t1/reactions?path=doc.md",
            json={"user_id": "u1", "user_name": "Alice", "emoji": "thumbsup"},
        )
        assert r.status_code == 204
        r = await full_client.request(
            "DELETE",
            "/documents/comments/t1/reactions?path=doc.md",
            json={"user_id": "u1", "user_name": "Alice", "emoji": "thumbsup"},
        )
        assert r.status_code == 204

        # Suggestion decision
        r = await full_client.post(
            "/documents/comments/t1/suggestion/decision?path=doc.md",
            json={"decision": "accepted", "decided_by": "u2"},
        )
        assert r.status_code == 200

        # Mentions
        r = await full_client.get(
            "/documents/comments/mentions/search?path=doc.md&q=ali&limit=3"
        )
        assert r.status_code == 200
        assert r.json()["candidates"][0]["user_id"] == "u1"

        # Poll
        r = await full_client.get("/documents/comments/poll?path=doc.md&since=t0")
        assert r.status_code == 200
        assert r.json()["changes"][0]["thread_id"] == "t1"

        assert full_provider.calls == [
            "update_comment",
            "delete_comment",
            "add_reaction:thumbsup",
            "remove_reaction:thumbsup",
            "decide:accepted",
            "search:ali:3",
            "poll:t0",
        ]


class TestYjsPayloadIsOpaque:
    async def test_create_and_get_roundtrip(
        self, core_provider: CoreProvider, core_client: AsyncClient
    ) -> None:
        want_payload = "AQIDBAUGBwgJCgsMDQ4PEA=="
        create = await core_client.post(
            "/documents/comments?path=doc.md",
            json={
                "anchor": {"start": 0, "end": 1, "quoted_text": "a"},
                "suggestion": {
                    "yjs_payload": want_payload,
                    "human_readable": {
                        "summary": "change",
                        "before_text": "a",
                        "after_text": "A",
                        "operations": [],
                    },
                    "author_id": "u1",
                    "author_name": "Alice",
                    "status": "pending",
                },
            },
        )
        assert create.status_code == 201
        body = create.json()
        assert body["suggestion"]["yjs_payload"] == want_payload

        tid = body["id"]
        # Verify the provider stored the payload byte-for-byte.
        stored_thread = core_provider.threads[tid]
        assert stored_thread.suggestion is not None
        assert stored_thread.suggestion.yjs_payload == want_payload

        get = await core_client.get(f"/documents/comments/{tid}?path=doc.md")
        assert get.status_code == 200
        assert get.json()["suggestion"]["yjs_payload"] == want_payload
