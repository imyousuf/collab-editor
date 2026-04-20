"""Python SDK for implementing collab-editor storage providers."""

from .types import (
    ContentResult,
    UpdatePayload,
    LoadResponse,
    StoreResponse,
    StoreRequest,
    HealthResponse,
    DocumentListEntry,
    FailedUpdate,
    SnapshotPayload,
    DocumentMetadata,
    VersionEntry,
    VersionListEntry,
    BlameSegment,
    CreateVersionRequest,
    ClientUserMapping,
)
from .engine import (
    extract_yjs_update,
    apply_base64_update,
    extract_text,
    create_doc_with_content,
    encode_doc_state,
)
from .cache import DocCache
from .blame import compute_blame_from_versions
from .provider import Provider, ProviderProcessor
from .handler import create_fastapi_router, serve

__all__ = [
    # Types
    "ContentResult",
    "UpdatePayload",
    "LoadResponse",
    "StoreResponse",
    "StoreRequest",
    "HealthResponse",
    "DocumentListEntry",
    "FailedUpdate",
    "SnapshotPayload",
    "DocumentMetadata",
    "VersionEntry",
    "VersionListEntry",
    "BlameSegment",
    "CreateVersionRequest",
    "ClientUserMapping",
    # Engine
    "extract_yjs_update",
    "apply_base64_update",
    "extract_text",
    "create_doc_with_content",
    "encode_doc_state",
    # Blame
    "compute_blame_from_versions",
    # Cache
    "DocCache",
    # Provider
    "Provider",
    "ProviderProcessor",
    # Handler
    "create_fastapi_router",
    "serve",
]
