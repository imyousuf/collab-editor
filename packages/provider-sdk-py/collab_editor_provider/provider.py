"""Provider interface and SDK processor.

Implementors write ``read_content()`` and optionally ``write_content()``,
``store_raw_updates()``, ``load_raw_updates()``.
The SDK handles Yjs diff application, state encoding, and text extraction.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from .types import (
    ContentResult,
    DocumentListEntry,
    HealthResponse,
    LoadResponse,
    StoreResponse,
    UpdatePayload,
)
from .engine import (
    apply_base64_update,
    create_doc_with_content,
    encode_doc_state,
    extract_text,
)
from .cache import DocCache


class Provider(ABC):
    """Interface that storage backends implement.

    Two storage strategies supported (choose one or both):

    1. **Resolved text mode**: Override ``read_content()`` + ``write_content()``.
       The SDK applies Yjs diffs and gives you the final text.

    2. **Raw updates mode**: Override ``read_content()`` + ``store_raw_updates()``
       + ``load_raw_updates()``. You store the raw Yjs binary yourself.

    3. **Both**: Override all methods. The SDK calls ``write_content()`` with
       resolved text AND ``store_raw_updates()`` with the raw diffs.
    """

    @abstractmethod
    async def read_content(self, document_id: str) -> ContentResult:
        """Read the current full text from your storage."""
        ...

    async def write_content(
        self, document_id: str, content: str, mime_type: str
    ) -> None:
        """Write the resolved full text back to your storage."""
        raise NotImplementedError

    async def store_raw_updates(
        self, document_id: str, updates: list[UpdatePayload]
    ) -> None:
        """Store raw Yjs updates for later replay -- append-only."""
        raise NotImplementedError

    async def load_raw_updates(self, document_id: str) -> list[UpdatePayload]:
        """Load previously stored raw Yjs updates for replay."""
        raise NotImplementedError

    async def delete_content(self, document_id: str) -> None:
        """Delete a document."""
        raise NotImplementedError

    async def list_documents(self) -> list[DocumentListEntry]:
        """List available documents."""
        raise NotImplementedError

    async def on_health(self) -> HealthResponse:
        """Custom health check."""
        return HealthResponse(status="ok")

    # --- Capability detection ---

    @property
    def supports_write_content(self) -> bool:
        return type(self).write_content is not Provider.write_content

    @property
    def supports_raw_updates(self) -> bool:
        return type(self).store_raw_updates is not Provider.store_raw_updates

    @property
    def supports_load_raw_updates(self) -> bool:
        return type(self).load_raw_updates is not Provider.load_raw_updates

    @property
    def supports_delete(self) -> bool:
        return type(self).delete_content is not Provider.delete_content

    @property
    def supports_list(self) -> bool:
        return type(self).list_documents is not Provider.list_documents


class ProviderProcessor:
    """SDK processor -- bridges Provider interface with the relay's SPI protocol."""

    def __init__(self, provider: Provider, *, cache_size: int = 1000) -> None:
        self._provider = provider
        self._cache = DocCache(cache_size)

    async def process_load(self, document_id: str) -> LoadResponse:
        result = await self._provider.read_content(document_id)

        # If provider stores raw updates, return them for replay
        raw_updates: list[UpdatePayload] = []
        if self._provider.supports_load_raw_updates:
            raw_updates = await self._provider.load_raw_updates(document_id)

        if raw_updates:
            return LoadResponse(
                content=result.content,
                mime_type=result.mime_type,
                updates=raw_updates,
            )

        # Otherwise encode current content as a Yjs state snapshot
        doc = self._cache.get(document_id)
        if doc is None:
            doc = create_doc_with_content(result.content)
            self._cache.set(document_id, doc)

        state_data = encode_doc_state(doc)
        return LoadResponse(
            content=result.content,
            mime_type=result.mime_type,
            updates=[UpdatePayload(sequence=0, data=state_data, client_id=0)],
        )

    async def process_store(
        self, document_id: str, updates: list[UpdatePayload]
    ) -> StoreResponse:
        if not updates:
            return StoreResponse(stored=0)

        # Store raw updates if provider supports it
        if self._provider.supports_raw_updates:
            await self._provider.store_raw_updates(document_id, updates)

        # Apply diffs and write resolved text if provider supports it
        if self._provider.supports_write_content:
            doc = self._cache.get(document_id)
            if doc is None:
                result = await self._provider.read_content(document_id)
                doc = create_doc_with_content(result.content)
                self._cache.set(document_id, doc)

            applied = 0
            for update in updates:
                if apply_base64_update(doc, update.data):
                    applied += 1

            resolved_text = extract_text(doc)
            result = await self._provider.read_content(document_id)
            await self._provider.write_content(
                document_id, resolved_text, result.mime_type
            )
            return StoreResponse(stored=applied)

        # If only store_raw_updates is implemented, count all as stored
        return StoreResponse(stored=len(updates))

    async def process_health(self) -> HealthResponse:
        return await self._provider.on_health()

    async def process_delete(self, document_id: str) -> None:
        self._cache.delete(document_id)
        if self._provider.supports_delete:
            await self._provider.delete_content(document_id)

    async def process_list(self) -> list[DocumentListEntry]:
        if self._provider.supports_list:
            return await self._provider.list_documents()
        return []

    def clear_cache(self) -> None:
        self._cache.clear()
