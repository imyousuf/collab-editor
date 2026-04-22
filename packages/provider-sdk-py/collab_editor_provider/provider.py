"""Provider interface and SDK processor.

Implementors write ``read_content()`` and optionally ``write_content()``,
``store_raw_updates()``, ``load_raw_updates()``.
The SDK handles Yjs diff application, state encoding, and text extraction.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from .types import (
    BlameSegment,
    ClientUserMapping,
    ContentResult,
    CreateVersionRequest,
    DocumentListEntry,
    HealthResponse,
    LoadResponse,
    StoreResponse,
    UpdatePayload,
    VersionEntry,
    VersionListEntry,
)
from .engine import (
    apply_base64_update,
    create_doc_with_content,
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
    def supports_list(self) -> bool:
        return type(self).list_documents is not Provider.list_documents

    # --- Version history (optional) ---

    async def list_versions(self, document_id: str) -> list[VersionListEntry]:
        """List versions for a document."""
        raise NotImplementedError

    async def create_version(
        self, document_id: str, req: CreateVersionRequest
    ) -> VersionListEntry:
        """Create a new version snapshot."""
        raise NotImplementedError

    async def get_version(
        self, document_id: str, version_id: str
    ) -> VersionEntry | None:
        """Get a full version with content and blame."""
        raise NotImplementedError

    # --- Client mappings (optional) ---

    async def get_client_mappings(
        self, document_id: str
    ) -> list[ClientUserMapping]:
        """Get client-ID-to-user mappings for blame."""
        raise NotImplementedError

    async def store_client_mappings(
        self, document_id: str, mappings: list[ClientUserMapping]
    ) -> None:
        """Store client-ID-to-user mappings."""
        raise NotImplementedError

    @property
    def supports_versions(self) -> bool:
        return type(self).list_versions is not Provider.list_versions

    @property
    def supports_client_mappings(self) -> bool:
        return type(self).get_client_mappings is not Provider.get_client_mappings


class ProviderProcessor:
    """SDK processor -- bridges Provider interface with the relay's SPI protocol."""

    def __init__(self, provider: Provider, *, cache_size: int = 1000) -> None:
        self._provider = provider
        self._cache = DocCache(cache_size)

    async def process_load(self, document_id: str) -> LoadResponse:
        result = await self._provider.read_content(document_id)

        # Seed the cache from provider content so subsequent stores work
        doc = self._cache.get(document_id)
        if doc is None:
            doc = create_doc_with_content(result.content)
            self._cache.set(document_id, doc)

        return LoadResponse(
            content=result.content,
            mime_type=result.mime_type,
        )

    async def process_store(
        self,
        document_id: str,
        updates: list[UpdatePayload],
        content: str | None = None,
        mime_type: str | None = None,
    ) -> StoreResponse:
        if not updates:
            return StoreResponse(stored=0)

        # Always resolve content via the pycrdt Y.Doc engine
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

        # Determine the mime_type: prefer what was sent in the request,
        # fall back to what the provider already has
        if mime_type is None:
            result = await self._provider.read_content(document_id)
            mime_type = result.mime_type

        # Store raw updates if provider supports it
        if self._provider.supports_raw_updates:
            await self._provider.store_raw_updates(document_id, updates)

        # Write resolved text if provider supports it
        if self._provider.supports_write_content:
            await self._provider.write_content(
                document_id, resolved_text, mime_type
            )

        return StoreResponse(stored=applied)

    async def process_health(self) -> HealthResponse:
        return await self._provider.on_health()

    async def process_list(self) -> list[DocumentListEntry]:
        if self._provider.supports_list:
            return await self._provider.list_documents()
        return []

    async def process_list_versions(
        self, document_id: str
    ) -> list[VersionListEntry]:
        if self._provider.supports_versions:
            return await self._provider.list_versions(document_id)
        return []

    async def process_create_version(
        self, document_id: str, req: CreateVersionRequest
    ) -> VersionListEntry | None:
        if self._provider.supports_versions:
            return await self._provider.create_version(document_id, req)
        return None

    async def process_get_version(
        self, document_id: str, version_id: str
    ) -> VersionEntry | None:
        if not self._provider.supports_versions:
            return None
        entry = await self._provider.get_version(document_id, version_id)
        if entry is None:
            return None

        # Auto-compute blame from version history if not populated
        if not entry.blame and self._provider.supports_versions:
            all_versions = await self._provider.list_versions(document_id)
            sorted_versions = sorted(
                [v for v in all_versions if v.created_at <= entry.created_at],
                key=lambda v: v.created_at,
            )
            if sorted_versions:
                full_versions: list[VersionEntry] = []
                for v in sorted_versions:
                    full = await self._provider.get_version(document_id, v.id)
                    if full is not None:
                        full_versions.append(full)
                if full_versions:
                    from .blame import compute_blame_from_versions
                    entry.blame = compute_blame_from_versions(full_versions)

        return entry

    async def process_get_client_mappings(
        self, document_id: str
    ) -> list[ClientUserMapping]:
        if self._provider.supports_client_mappings:
            return await self._provider.get_client_mappings(document_id)
        return []

    async def process_store_client_mappings(
        self, document_id: str, mappings: list[ClientUserMapping]
    ) -> None:
        if self._provider.supports_client_mappings:
            await self._provider.store_client_mappings(document_id, mappings)

    def clear_cache(self) -> None:
        self._cache.clear()
