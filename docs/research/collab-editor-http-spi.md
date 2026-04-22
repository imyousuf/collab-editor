# Collaborative Editor: HTTP-Based Storage Provider Interface

## Overview

The Go WebSocket relay delegates all document persistence to an external HTTP service — the **Storage Provider**. Implementors deploy their own service conforming to this API contract, in any language, backed by any storage system. The relay is configured with a single provider base URL and communicates exclusively via REST.

**The SPI is fully Yjs-agnostic.** Providers never handle Y.Doc instances, Y.Text objects, or binary CRDT updates. The Provider SDKs (Go, TypeScript, Python) resolve Y.js diffs internally and deliver plain text content to the provider. Providers implement simple read/write operations for document content strings.

Provider SDKs are available in [Go, TypeScript, and Python](../provider-sdk.md) to handle protocol details automatically.

```
┌──────────────┐          ┌──────────────────┐          ┌──────────────────┐
│  Browser     │  ws://   │  Go Relay         │  HTTP    │  Provider SDK    │
│  <collab-    │─────────→│  (stateless,      │─────────→│  (resolves Yjs   │
│   editor />  │  Yjs     │   binary relay)   │  REST    │   diffs to text) │
│              │  binary  │                   │          │        │         │
└──────────────┘          └──────────────────┘          │        ▼         │
                                                        │  Your Provider   │
                                                        │  (plain text     │
                                                        │   read/write)    │
                                                        └──────────────────┘
                                                               │
                                                    ┌──────────┼──────────┐
                                                    ▼          ▼          ▼
                                              PostgreSQL    S3/GCS    Custom
```

---

## HTTP SPI Contract

All request and response bodies are JSON. The provider MUST support concurrent requests for different document IDs and SHOULD be idempotent on writes. No endpoint requires the provider to handle Y.js binary data — the SDK resolves all CRDT operations before invoking provider methods.

Document IDs are passed as the `path` query parameter (e.g., `?path=my-doc.md`), not as path segments. This avoids URL encoding issues with document IDs containing dots or slashes.

### Base Configuration

```yaml
# Relay config
storage:
  provider_url: "https://storage.internal.example.com"
  auth:
    type: "bearer"
    token: "${STORAGE_TOKEN}"
  timeouts:
    load: 10s
    store: 5s
  retry:
    max_attempts: 3
    backoff: exponential     # 100ms, 200ms, 400ms
```

---

### Endpoints

#### `GET /health`

Health check. The relay uses this for circuit-breaking.

**Response — 200 OK:**
```json
{
  "status": "ok",
  "storage": "connected"
}
```

**Response — 503 Service Unavailable:**
```json
{
  "status": "degraded",
  "storage": "disconnected"
}
```

---

#### `POST /documents/load?path={documentId}`

Load the latest document content for room bootstrap. Called once when the first peer joins a room. The provider returns the current resolved plain text — no Y.js binary data.

```
POST /documents/load?path=my-doc.md
Content-Type: application/json
Authorization: Bearer {relay-token}
```

**Response — 200 OK:**
```json
{
  "content": "# Hello World\n\nDocument text.",
  "mime_type": "text/markdown",
  "metadata": {
    "format": "markdown",
    "language": "javascript",
    "created_by": "user-alice",
    "permissions": "read-write"
  }
}
```

Fields:
- `content` — The latest resolved document text (plain text, not CRDT binary)
- `mime_type` — MIME type for editor mode selection
- `metadata` — Optional document metadata

A response with empty `content` means a new/empty document.

---

#### `POST /documents/updates?path={documentId}`

Persist a batch of document updates. Called asynchronously by the relay's flush pipeline. The Provider SDK resolves Y.js diffs internally and populates the `content` and `mime_type` fields with the latest resolved document text before this request reaches the provider.

```
POST /documents/updates?path=my-doc.md
Content-Type: application/json
Authorization: Bearer {relay-token}

{
  "updates": [
    {
      "sequence": 1042,
      "data": "<base64>",
      "client_id": 1234567890,
      "created_at": "2026-04-14T10:32:01.123Z"
    },
    {
      "sequence": 1043,
      "data": "<base64>",
      "client_id": 9876543210,
      "created_at": "2026-04-14T10:32:01.456Z"
    }
  ],
  "content": "# Hello World\n\nUpdated document text.",
  "mime_type": "text/markdown"
}
```

Fields:
- `updates` — Raw Y.js update entries (the relay sends these; the SDK resolves them)
- `content` — The latest resolved document text after applying all updates (populated by the SDK)
- `mime_type` — MIME type of the document

Providers should persist the `content` field. The `updates` array is present for SDK processing but providers using the SDK never need to interpret the raw Y.js data — the SDK resolves it to `content` before calling the provider's store method.

**Response — 202 Accepted:**
```json
{
  "stored": 2,
  "duplicates_ignored": 0
}
```

**Response — 207 Multi-Status** (partial failure):
```json
{
  "stored": 1,
  "failed": [
    { "sequence": 1043, "error": "storage_full" }
  ]
}
```

> The relay treats 202 as success and discards the buffer. On 5xx or network failure, the relay re-queues updates for retry with exponential backoff. On 207, only failed updates are re-queued.

---

#### `GET /documents`

List available documents (optional).

```
GET /documents
Authorization: Bearer {relay-token}
```

**Response — 200 OK:**
```json
{
  "documents": [
    {
      "name": "welcome.md",
      "size": 545,
      "mime_type": "text/markdown"
    },
    {
      "name": "app.jsx",
      "size": 2172,
      "mime_type": "text/jsx"
    }
  ]
}
```

---

#### `POST /documents/compact?path={documentId}` (Optional)

Compact accumulated raw updates. This is an implementation-specific optimization endpoint — it is not part of the core Yjs-agnostic SPI and is only relevant if the provider chooses to store raw update journals alongside resolved content.

```
POST /documents/compact?path=my-doc.md
Content-Type: application/json
Authorization: Bearer {relay-token}

{
  "snapshot": {
    "data": "<base64>",
    "state_vector": "<base64>",
    "update_count": 150
  },
  "replace_sequences_up_to": 1043
}
```

**Response — 200 OK:**
```json
{
  "compacted": true,
  "updates_removed": 150,
  "snapshot_size_bytes": 24576
}
```

---

#### `GET /documents/versions?path={documentId}` (Optional)

List version snapshots for a document. Returns lightweight entries (no content or blame).

**Response — 200 OK:**
```json
{
  "versions": [
    {
      "id": "a1b2c3d4",
      "created_at": "2026-04-14T10:30:00Z",
      "type": "manual",
      "label": "Before refactor",
      "creator": "alice"
    }
  ]
}
```

---

#### `POST /documents/versions?path={documentId}` (Optional)

Create a new version snapshot.

```json
{
  "content": "Document text at this version",
  "mime_type": "text/markdown",
  "label": "Before refactor",
  "creator": "alice",
  "type": "manual"
}
```

**Response — 201 Created:** Returns the created `VersionListEntry`.

---

#### `GET /documents/versions/detail?path={documentId}&version={versionId}` (Optional)

Get a full version with content and blame attribution.

**Response — 200 OK:**
```json
{
  "id": "a1b2c3d4",
  "created_at": "2026-04-14T10:30:00Z",
  "type": "manual",
  "content": "Document text at this version",
  "blame": [
    { "start": 0, "end": 15, "user_name": "alice" },
    { "start": 15, "end": 30, "user_name": "bob" }
  ]
}
```

Blame segments attribute character ranges to users. Color is NOT included — the frontend assigns colors.

---

#### `GET /documents/clients?path={documentId}` (Optional)

Get client-ID-to-user mappings for blame attribution across sessions.

**Response — 200 OK:**
```json
{
  "mappings": [
    { "client_id": 1234567890, "user_name": "alice" },
    { "client_id": 9876543210, "user_name": "bob" }
  ]
}
```

---

#### `POST /documents/clients?path={documentId}` (Optional)

Store client-ID-to-user mappings.

```json
{
  "mappings": [
    { "client_id": 1234567890, "user_name": "alice" }
  ]
}
```

**Response — 200 OK:** `{ "stored": 1 }`

---

## Async Pipeline with HTTP

```
 Peer edit
   │
   ▼
 Broadcast to peers (immediate, in-process)
   │
   ▼
 Buffer accumulator (in-memory ring buffer)
   │
   │  flush triggers:
   │  ├─ debounce timer fires (2s)
   │  ├─ buffer exceeds 64KB
   │  └─ room closing (last peer disconnects)
   │
   ▼
 ┌───────────────────────────────────────────────┐
 │  Flush goroutine                               │
 │                                                │
 │  1. Drain buffer → []UpdatePayload             │
 │  2. POST /documents/updates?path={id}          │
 │     (SDK resolves Yjs diffs → plain text)      │
 │  3. Provider receives resolved content string  │
 │  4. On 202 → discard buffer, done              │
 │  5. On 207 → re-queue failed updates only      │
 │  6. On 5xx/timeout → re-queue all, backoff     │
 │     (100ms → 200ms → 400ms → 800ms → 1.6s)    │
 │  7. After 3 failures → log error, emit metric, │
 │     keep buffering (client y-indexeddb is the   │
 │     durability backstop)                        │
 └───────────────────────────────────────────────┘
```

---

## Metrics the Relay Emits

```
collab_relay_rooms_active          gauge
collab_relay_peers_connected       gauge
collab_relay_updates_relayed_total counter  {document_id}
collab_relay_updates_buffered      gauge    {document_id}
collab_relay_flush_duration_ms     histogram
collab_relay_flush_errors_total    counter  {status_code}
collab_relay_provider_latency_ms   histogram {endpoint}
collab_relay_provider_circuit_open gauge
```

---

## Provider Implementation Checklist

For implementors building their own storage provider (or use the [Provider SDKs](../provider-sdk.md)):

```
Required Endpoints:
  ✅ GET    /health
  ✅ POST   /documents/load?path={id}       — returns content + mime_type (plain text)
  ✅ POST   /documents/updates?path={id}    — receives content + mime_type (plain text)

Optional Endpoints:
  ⬜ GET    /documents
  ⬜ POST   /documents/compact?path={id}
  ⬜ GET    /documents/versions?path={id}
  ⬜ POST   /documents/versions?path={id}
  ⬜ GET    /documents/versions/detail?path={id}&version={versionId}
  ⬜ GET    /documents/clients?path={id}
  ⬜ POST   /documents/clients?path={id}

Requirements:
  ✅ Yjs-agnostic — providers never handle Y.Doc, Y.Text, or CRDT binary
  ✅ Idempotent writes (duplicate sequence numbers ignored)
  ✅ Concurrent-safe (multiple relay instances may call simultaneously)
  ✅ Auth via Bearer token
  ✅ JSON request/response bodies
  ✅ Document IDs via 'path' query parameter

Performance Targets:
  • /load    < 500ms p99 (cold start path)
  • /updates < 100ms p99 (async, but affects flush throughput)
```
