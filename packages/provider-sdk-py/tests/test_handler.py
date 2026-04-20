"""Tests for the FastAPI handler."""

from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI

from collab_editor_provider.types import ContentResult, DocumentListEntry, HealthResponse
from collab_editor_provider.provider import Provider
from collab_editor_provider.handler import create_fastapi_router
from .conftest import load_fixture


class MockProvider(Provider):
    def __init__(self) -> None:
        self.store: dict[str, tuple[str, str]] = {}

    async def read_content(self, document_id: str) -> ContentResult:
        entry = self.store.get(document_id)
        if entry:
            return ContentResult(content=entry[0], mime_type=entry[1])
        return ContentResult(content="", mime_type="text/plain")

    async def write_content(
        self, document_id: str, content: str, mime_type: str
    ) -> None:
        self.store[document_id] = (content, mime_type)

    async def list_documents(self) -> list[DocumentListEntry]:
        return [
            DocumentListEntry(name=k, mime_type=v[1])
            for k, v in self.store.items()
        ]


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def app(mock_provider: MockProvider) -> FastAPI:
    application = FastAPI()
    application.include_router(create_fastapi_router(mock_provider))
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncClient:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c  # type: ignore[misc]


class TestHealthEndpoint:
    async def test_health_returns_ok(self, client: AsyncClient) -> None:
        resp = await client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


class TestLoadEndpoint:
    async def test_load_returns_content(
        self, mock_provider: MockProvider, client: AsyncClient
    ) -> None:
        mock_provider.store["doc1"] = ("# Hello", "text/markdown")
        resp = await client.post("/documents/load?path=doc1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "# Hello"
        assert data["mime_type"] == "text/markdown"
        assert "updates" in data

    async def test_load_missing_path(self, client: AsyncClient) -> None:
        resp = await client.post("/documents/load")
        assert resp.status_code == 422  # FastAPI validation error


class TestStoreEndpoint:
    async def test_store_applies_updates(
        self, mock_provider: MockProvider, client: AsyncClient
    ) -> None:
        fixture = load_fixture("001-simple-insert")
        mock_provider.store["doc1"] = ("", "text/plain")

        resp = await client.post(
            "/documents/updates?path=doc1",
            json={"updates": fixture["updates"]},
        )
        assert resp.status_code == 202
        data = resp.json()
        assert data["stored"] > 0

        stored = mock_provider.store.get("doc1")
        assert stored is not None
        assert stored[0] == fixture["expected_text"]

    async def test_store_empty_updates(self, client: AsyncClient) -> None:
        resp = await client.post(
            "/documents/updates?path=doc1",
            json={"updates": []},
        )
        assert resp.status_code == 202
        assert resp.json()["stored"] == 0


class TestListEndpoint:
    async def test_list_documents(
        self, mock_provider: MockProvider, client: AsyncClient
    ) -> None:
        mock_provider.store["a.md"] = ("", "text/markdown")
        mock_provider.store["b.js"] = ("", "text/javascript")

        resp = await client.get("/documents")
        assert resp.status_code == 200
        docs = resp.json()["documents"]
        assert len(docs) == 2
