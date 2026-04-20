"""HTTP handler factory for FastAPI.

Two integration modes:
1. ``create_fastapi_router(provider)`` -- returns an APIRouter, include on your app
2. Use ``ProviderProcessor`` directly -- call process_load/process_store from your own endpoint
"""

from __future__ import annotations

from typing import Any

from .provider import Provider, ProviderProcessor
from .types import StoreRequest, UpdatePayload


def create_fastapi_router(
    provider: Provider,
    *,
    cache_size: int = 1000,
) -> Any:
    """Create a FastAPI APIRouter with the standard SPI endpoints.

    Usage::

        from fastapi import FastAPI
        from collab_editor_provider import create_fastapi_router

        app = FastAPI()
        app.include_router(create_fastapi_router(my_provider), prefix="/collab")
    """
    from fastapi import APIRouter, Query
    from fastapi.responses import JSONResponse

    router = APIRouter()
    processor = ProviderProcessor(provider, cache_size=cache_size)

    @router.get("/health")
    async def health() -> dict[str, Any]:
        resp = await processor.process_health()
        return {"status": resp.status, **({"storage": resp.storage} if resp.storage else {})}

    @router.post("/documents/load")
    async def load_document(path: str = Query(...)) -> dict[str, Any]:
        resp = await processor.process_load(path)
        result: dict[str, Any] = {
            "content": resp.content,
            "mime_type": resp.mime_type,
        }
        if resp.updates:
            result["updates"] = [
                {
                    "sequence": u.sequence,
                    "data": u.data,
                    "client_id": u.client_id,
                    **({"created_at": u.created_at} if u.created_at else {}),
                }
                for u in resp.updates
            ]
        return result

    @router.post("/documents/updates")
    async def store_updates(
        body: dict[str, Any],
        path: str = Query(...),
    ) -> JSONResponse:
        raw_updates = body.get("updates", [])
        updates = [
            UpdatePayload(
                sequence=u["sequence"],
                data=u["data"],
                client_id=u["client_id"],
                created_at=u.get("created_at"),
            )
            for u in raw_updates
        ]
        resp = await processor.process_store(path, updates)
        result: dict[str, Any] = {"stored": resp.stored}
        if resp.failed:
            result["failed"] = [
                {"sequence": f.sequence, "error": f.error} for f in resp.failed
            ]
            return JSONResponse(content=result, status_code=207)
        return JSONResponse(content=result, status_code=202)

    if provider.supports_delete:

        @router.delete("/documents")
        async def delete_document(path: str = Query(...)) -> dict[str, bool]:
            await processor.process_delete(path)
            return {"deleted": True}

    if provider.supports_list:

        @router.get("/documents")
        async def list_documents() -> dict[str, Any]:
            docs = await processor.process_list()
            return {
                "documents": [
                    {"name": d.name, "size": d.size, "mime_type": d.mime_type}
                    for d in docs
                ]
            }

    return router


def serve(
    provider: Provider,
    *,
    port: int = 8081,
    cache_size: int = 1000,
) -> None:
    """Create a standalone HTTP server with the SPI endpoints.

    Usage::

        from collab_editor_provider import serve
        serve(my_provider, port=8081)
    """
    import uvicorn
    from fastapi import FastAPI

    app = FastAPI(title="collab-editor-provider")
    app.include_router(create_fastapi_router(provider, cache_size=cache_size))
    uvicorn.run(app, host="0.0.0.0", port=port)
