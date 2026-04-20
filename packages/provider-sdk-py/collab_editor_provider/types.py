"""SPI request/response types matching the relay's JSON payloads."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class UpdatePayload:
    sequence: int
    data: str  # base64-encoded y-websocket binary
    client_id: int
    created_at: Optional[str] = None


@dataclass
class SnapshotPayload:
    data: str
    state_vector: str
    created_at: str
    update_count: int


@dataclass
class DocumentMetadata:
    format: Optional[str] = None
    language: Optional[str] = None
    created_by: Optional[str] = None
    permissions: Optional[str] = None


@dataclass
class LoadResponse:
    content: str = ""
    mime_type: str = "text/plain"
    updates: list[UpdatePayload] = field(default_factory=list)
    snapshot: Optional[SnapshotPayload] = None
    metadata: Optional[DocumentMetadata] = None


@dataclass
class StoreRequest:
    updates: list[UpdatePayload] = field(default_factory=list)


@dataclass
class StoreResponse:
    stored: int = 0
    duplicates_ignored: Optional[int] = None
    failed: Optional[list[FailedUpdate]] = None


@dataclass
class FailedUpdate:
    sequence: int
    error: str


@dataclass
class HealthResponse:
    status: str = "ok"
    storage: Optional[str] = None


@dataclass
class DocumentListEntry:
    name: str
    size: int = 0
    mime_type: str = "text/plain"


@dataclass
class ContentResult:
    content: str
    mime_type: str = "text/plain"
