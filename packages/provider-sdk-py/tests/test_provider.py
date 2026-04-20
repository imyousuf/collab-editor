"""Tests for the Provider and ProviderProcessor."""

from __future__ import annotations

import pytest

from collab_editor_provider.types import (
    ContentResult,
    DocumentListEntry,
    HealthResponse,
    UpdatePayload,
)
from collab_editor_provider.provider import Provider, ProviderProcessor
from .conftest import load_fixture


class MockProvider(Provider):
    """In-memory mock provider for testing."""

    def __init__(self) -> None:
        self.store: dict[str, tuple[str, str]] = {}  # doc_id -> (content, mime_type)

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


class TestProviderProcessor:
    @pytest.fixture
    def mock_provider(self) -> MockProvider:
        return MockProvider()

    @pytest.fixture
    def processor(self, mock_provider: MockProvider) -> ProviderProcessor:
        return ProviderProcessor(mock_provider)

    async def test_process_load_returns_content(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        mock_provider.store["doc1"] = ("# Hello", "text/markdown")
        resp = await processor.process_load("doc1")
        assert resp.content == "# Hello"
        assert resp.mime_type == "text/markdown"
        assert len(resp.updates) == 1

    async def test_process_load_empty_for_nonexistent(
        self, processor: ProviderProcessor
    ) -> None:
        resp = await processor.process_load("nonexistent")
        assert resp.content == ""

    async def test_process_store_applies_diffs(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        fixture = load_fixture("001-simple-insert")
        mock_provider.store["doc1"] = ("", "text/plain")

        updates = [
            UpdatePayload(
                sequence=u["sequence"], data=u["data"], client_id=u["client_id"]
            )
            for u in fixture["updates"]
        ]
        resp = await processor.process_store("doc1", updates)
        assert resp.stored > 0

        stored = mock_provider.store.get("doc1")
        assert stored is not None
        assert stored[0] == fixture["expected_text"]

    async def test_process_store_multiple_updates(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        fixture = load_fixture("002-multiple-inserts")
        mock_provider.store["doc1"] = ("", "text/plain")

        updates = [
            UpdatePayload(
                sequence=u["sequence"], data=u["data"], client_id=u["client_id"]
            )
            for u in fixture["updates"]
        ]
        await processor.process_store("doc1", updates)

        stored = mock_provider.store.get("doc1")
        assert stored is not None
        assert stored[0] == fixture["expected_text"]

    async def test_process_store_empty_is_noop(
        self, processor: ProviderProcessor
    ) -> None:
        resp = await processor.process_store("doc1", [])
        assert resp.stored == 0

    async def test_sequential_stores_accumulate(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        fixture1 = load_fixture("001-simple-insert")
        mock_provider.store["doc1"] = ("", "text/plain")

        updates1 = [
            UpdatePayload(
                sequence=u["sequence"], data=u["data"], client_id=u["client_id"]
            )
            for u in fixture1["updates"]
        ]
        await processor.process_store("doc1", updates1)
        assert mock_provider.store["doc1"][0] == "hello"

        fixture2 = load_fixture("002-multiple-inserts")
        updates2 = [
            UpdatePayload(
                sequence=u["sequence"], data=u["data"], client_id=u["client_id"]
            )
            for u in fixture2["updates"]
        ]
        await processor.process_store("doc1", updates2)

        stored = mock_provider.store.get("doc1")
        assert stored is not None
        assert len(stored[0]) > 0  # content accumulated

    async def test_process_load_after_store(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        fixture = load_fixture("001-simple-insert")
        mock_provider.store["doc1"] = ("", "text/plain")

        updates = [
            UpdatePayload(
                sequence=u["sequence"], data=u["data"], client_id=u["client_id"]
            )
            for u in fixture["updates"]
        ]
        await processor.process_store("doc1", updates)

        resp = await processor.process_load("doc1")
        assert resp.content == "hello"
        assert len(resp.updates) == 1

    async def test_process_list(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        mock_provider.store["a.md"] = ("", "text/markdown")
        mock_provider.store["b.js"] = ("", "text/javascript")

        docs = await processor.process_list()
        assert len(docs) == 2

    async def test_process_health_default(
        self, processor: ProviderProcessor
    ) -> None:
        resp = await processor.process_health()
        assert resp.status == "ok"

    async def test_process_health_custom(
        self, mock_provider: MockProvider, processor: ProviderProcessor
    ) -> None:
        async def custom_health() -> HealthResponse:
            return HealthResponse(status="degraded", storage="disk full")

        mock_provider.on_health = custom_health  # type: ignore[assignment]

        resp = await processor.process_health()
        assert resp.status == "degraded"
        assert resp.storage == "disk full"


class TestSharedFixturesRoundTrip:
    """Run shared fixtures through the full ProviderProcessor pipeline."""

    FIXTURE_NAMES = [
        "001-simple-insert",
        "002-multiple-inserts",
        "003-delete",
        "005-large-document",
        "007-unicode",
        "008-rapid-edits",
        "009-replace-content",
    ]

    @pytest.fixture(params=FIXTURE_NAMES)
    def fixture_name(self, request: pytest.FixtureRequest) -> str:
        return request.param

    async def test_fixture_round_trip(self, fixture_name: str) -> None:
        fixture = load_fixture(fixture_name)
        provider = MockProvider()
        provider.store["test-doc"] = (fixture["initial_content"], "text/plain")
        processor = ProviderProcessor(provider)

        updates = [
            UpdatePayload(
                sequence=u["sequence"], data=u["data"], client_id=u["client_id"]
            )
            for u in fixture["updates"]
        ]
        await processor.process_store("test-doc", updates)

        stored = provider.store.get("test-doc")
        assert stored is not None
        assert stored[0] == fixture["expected_text"]
