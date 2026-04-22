"""FastAPI router factory for a CommentsProvider.

Plain REST + JSON — no Yjs dependency. Routes are registered conditionally
based on ``supports_*`` properties on the provider.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from .provider import CommentsProvider
from .types import (
    AddReplyRequest,
    CommentAnchor,
    CreateCommentThreadRequest,
    Mention,
    NewComment,
    OperationSummary,
    ReactionRequest,
    Suggestion,
    SuggestionDecisionRequest,
    SuggestionView,
    UpdateCommentRequest,
    UpdateThreadStatusRequest,
)


def _parse_anchor(d: dict[str, Any]) -> CommentAnchor:
    return CommentAnchor(
        start=int(d.get("start", 0)),
        end=int(d.get("end", 0)),
        quoted_text=str(d.get("quoted_text", "")),
    )


def _parse_mentions(raw: Any) -> list[Mention]:
    if not raw:
        return []
    return [
        Mention(user_id=str(m["user_id"]), display_name=str(m["display_name"]))
        for m in raw
    ]


def _parse_suggestion(d: dict[str, Any]) -> Suggestion:
    view_raw = d.get("human_readable", {})
    operations = [
        OperationSummary(
            kind=str(o.get("kind", "")),
            offset=int(o.get("offset", 0)),
            length=int(o.get("length", 0)),
            inserted_text=o.get("inserted_text"),
            format_change=o.get("format_change"),
        )
        for o in view_raw.get("operations", [])
    ]
    view = SuggestionView(
        summary=str(view_raw.get("summary", "")),
        before_text=str(view_raw.get("before_text", "")),
        after_text=str(view_raw.get("after_text", "")),
        operations=operations,
    )
    return Suggestion(
        yjs_payload=str(d.get("yjs_payload", "")),
        human_readable=view,
        author_id=str(d.get("author_id", "")),
        author_name=str(d.get("author_name", "")),
        author_note=d.get("author_note"),
        status=d.get("status", "pending"),
        decided_by=d.get("decided_by"),
        decided_at=d.get("decided_at"),
        applied_version_id=d.get("applied_version_id"),
    )


def _dump(obj: Any) -> Any:
    """Serialize a dataclass (or nested dataclass structure) to a dict,
    stripping keys whose values are None so JSON stays compact.
    """
    if obj is None:
        return None
    if hasattr(obj, "__dataclass_fields__"):
        out: dict[str, Any] = {}
        for k, v in asdict(obj).items():
            if v is None:
                continue
            out[k] = v
        return out
    return obj


def create_comments_fastapi_router(provider: CommentsProvider) -> Any:
    """Create a FastAPI APIRouter with the standard Comments SPI endpoints."""
    from fastapi import APIRouter, Body, Query
    from fastapi.responses import JSONResponse

    router = APIRouter()

    @router.get("/capabilities")
    async def get_capabilities() -> dict[str, Any]:
        caps = await provider.capabilities()
        return asdict(caps)

    @router.get("/documents/comments")
    async def list_threads(path: str = Query(...)) -> dict[str, Any]:
        threads = await provider.list_comment_threads(path)
        return {"threads": [asdict(t) for t in threads]}

    @router.post("/documents/comments")
    async def create_thread(
        body: dict[str, Any] = Body(...),
        path: str = Query(...),
    ) -> JSONResponse:
        anchor = _parse_anchor(body.get("anchor", {}))
        comment_raw = body.get("comment")
        comment = None
        if comment_raw:
            comment = NewComment(
                author_id=str(comment_raw.get("author_id", "")),
                author_name=str(comment_raw.get("author_name", "")),
                content=str(comment_raw.get("content", "")),
                mentions=_parse_mentions(comment_raw.get("mentions")),
            )
        suggestion_raw = body.get("suggestion")
        suggestion = _parse_suggestion(suggestion_raw) if suggestion_raw else None

        req = CreateCommentThreadRequest(
            anchor=anchor, comment=comment, suggestion=suggestion
        )
        thread = await provider.create_comment_thread(path, req)
        return JSONResponse(content=asdict(thread), status_code=201)

    # Mentions search + poll are mounted before /{threadId} to avoid
    # shadowing (FastAPI matches the first registered route).
    if provider.supports_mentions:

        @router.get("/documents/comments/mentions/search")
        async def search_mentions(
            path: str = Query(...),
            q: str = Query(""),
            limit: int = Query(10),
        ) -> dict[str, Any]:
            candidates = await provider.search_mentions(path, q, limit)
            return {"candidates": [asdict(c) for c in candidates]}

    if provider.supports_poll:

        @router.get("/documents/comments/poll")
        async def poll(path: str = Query(...), since: str = Query("")) -> dict[str, Any]:
            resp = await provider.poll_comment_changes(path, since)
            return asdict(resp)

    @router.get("/documents/comments/{thread_id}")
    async def get_thread(thread_id: str, path: str = Query(...)) -> JSONResponse:
        thread = await provider.get_comment_thread(path, thread_id)
        if thread is None:
            return JSONResponse(
                content={"error": "thread not found"}, status_code=404
            )
        return JSONResponse(content=asdict(thread), status_code=200)

    @router.post("/documents/comments/{thread_id}/replies")
    async def add_reply(
        thread_id: str,
        body: dict[str, Any] = Body(...),
        path: str = Query(...),
    ) -> JSONResponse:
        req = AddReplyRequest(
            author_id=str(body.get("author_id", "")),
            author_name=str(body.get("author_name", "")),
            content=str(body.get("content", "")),
            mentions=_parse_mentions(body.get("mentions")),
        )
        comment = await provider.add_reply(path, thread_id, req)
        return JSONResponse(content=asdict(comment), status_code=201)

    @router.patch("/documents/comments/{thread_id}")
    async def patch_thread(
        thread_id: str,
        body: dict[str, Any] = Body(...),
        path: str = Query(...),
    ) -> dict[str, Any]:
        req = UpdateThreadStatusRequest(
            status=body.get("status", "open"),
            resolved_by=body.get("resolved_by"),
        )
        thread = await provider.update_thread_status(path, thread_id, req)
        return asdict(thread)

    @router.delete("/documents/comments/{thread_id}")
    async def delete_thread(thread_id: str, path: str = Query(...)) -> JSONResponse:
        await provider.delete_comment_thread(path, thread_id)
        return JSONResponse(content=None, status_code=204)

    if provider.supports_comment_edit:

        @router.patch("/documents/comments/{thread_id}/comments/{comment_id}")
        async def patch_comment(
            thread_id: str,
            comment_id: str,
            body: dict[str, Any] = Body(...),
            path: str = Query(...),
        ) -> dict[str, Any]:
            req = UpdateCommentRequest(
                content=str(body.get("content", "")),
                mentions=_parse_mentions(body.get("mentions")),
                edited_by=body.get("edited_by"),
            )
            comment = await provider.update_comment(path, thread_id, comment_id, req)
            return asdict(comment)

        @router.delete("/documents/comments/{thread_id}/comments/{comment_id}")
        async def delete_comment(
            thread_id: str, comment_id: str, path: str = Query(...)
        ) -> JSONResponse:
            await provider.delete_comment(path, thread_id, comment_id)
            return JSONResponse(content=None, status_code=204)

    if provider.supports_reactions:

        @router.post("/documents/comments/{thread_id}/reactions")
        async def add_reaction(
            thread_id: str,
            body: dict[str, Any] = Body(...),
            path: str = Query(...),
        ) -> JSONResponse:
            req = ReactionRequest(
                user_id=str(body.get("user_id", "")),
                user_name=str(body.get("user_name", "")),
                emoji=str(body.get("emoji", "")),
                comment_id=body.get("comment_id"),
            )
            await provider.add_reaction(path, thread_id, req)
            return JSONResponse(content=None, status_code=204)

        @router.delete("/documents/comments/{thread_id}/reactions")
        async def remove_reaction(
            thread_id: str,
            body: dict[str, Any] = Body(...),
            path: str = Query(...),
        ) -> JSONResponse:
            req = ReactionRequest(
                user_id=str(body.get("user_id", "")),
                user_name=str(body.get("user_name", "")),
                emoji=str(body.get("emoji", "")),
                comment_id=body.get("comment_id"),
            )
            await provider.remove_reaction(path, thread_id, req)
            return JSONResponse(content=None, status_code=204)

    if provider.supports_suggestions:

        @router.post("/documents/comments/{thread_id}/suggestion/decision")
        async def decide_suggestion(
            thread_id: str,
            body: dict[str, Any] = Body(...),
            path: str = Query(...),
        ) -> dict[str, Any]:
            req = SuggestionDecisionRequest(
                decision=body.get("decision", "rejected"),
                decided_by=str(body.get("decided_by", "")),
                applied_version_id=body.get("applied_version_id"),
            )
            thread = await provider.decide_suggestion(path, thread_id, req)
            return asdict(thread)

    return router
