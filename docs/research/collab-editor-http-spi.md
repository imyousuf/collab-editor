# Collaborative Editor: HTTP-Based Storage Provider Interface

## Overview

The Go WebSocket relay delegates all document persistence to an external HTTP service — the **Storage Provider**. Implementors deploy their own service conforming to this API contract, in any language, backed by any storage system. The relay is configured with a single provider base URL and communicates exclusively via REST.

```
┌──────────────┐          ┌──────────────────┐          ┌──────────────────┐
│  Browser     │  ws://   │  Go Relay         │  HTTP    │  Storage Provider│
│  <collab-    │─────────→│  (stateless,      │─────────→│  (any language,  │
│   editor />  │  Yjs     │   binary relay)   │  REST    │   any storage)   │
│              │  binary  │                   │          │                  │
└──────────────┘          └──────────────────┘          └──────────────────┘
                                                               │
                                                    ┌──────────┼──────────┐
                                                    ▼          ▼          ▼
                                              PostgreSQL    S3/GCS    Custom
```

---

## HTTP SPI Contract

All request and response bodies are either JSON (metadata) or raw binary (`application/octet-stream` for Yjs update blobs). The provider MUST support concurrent requests for different document IDs and SHOULD be idempotent on writes.

### Base Configuration

```yaml
# Relay config
storage:
  provider_url: "https://storage.internal.example.com"
  auth:
    type: "bearer"           # or "hmac", "mtls"
    token: "${STORAGE_TOKEN}" # relay authenticates to provider
  timeouts:
    load: 10s
    store: 5s
    compact: 30s
  retry:
    max_attempts: 3
    backoff: exponential     # 100ms, 200ms, 400ms
```

---

### Endpoints

#### `POST /documents/{documentId}/load`

Load document state for room bootstrap. Called once when the first peer joins a room.

```
POST /documents/{documentId}/load
Content-Type: application/json
Authorization: Bearer {relay-token}

{
  "state_vector": "base64-encoded-state-vector"  // optional, from relay cache
}
```

**Response — 200 OK:**
```json
{
  "snapshot": {
    "data": "<base64>",
    "state_vector": "<base64>",
    "created_at": "2026-04-14T10:30:00Z",
    "update_count": 847
  },
  "updates": [
    {
      "sequence": 848,
      "data": "<base64>",
      "client_id": 1234567890,
      "created_at": "2026-04-14T10:31:12Z"
    }
  ],
  "metadata": {
    "format": "markdown",
    "language": "javascript",
    "created_by": "user-alice",
    "permissions": "read-write"
  }
}
```

**Response — 204 No Content:**
Document doesn't exist yet (new document). Relay creates an empty room.

**Response — 403 Forbidden:**
```json
{ "error": "insufficient_permissions", "message": "Document requires write access" }
```

> **Why POST instead of GET?** The optional `state_vector` in the request body enables differential loading — the provider can compute and return only the updates the relay is missing, rather than the full document. This is critical for reconnection scenarios where the relay already has a cached partial state.

---

#### `POST /documents/{documentId}/updates`

Persist a batch of incremental updates. Called asynchronously by the relay's flush pipeline.

```
POST /documents/{documentId}/updates
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
  ]
}
```

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

#### `POST /documents/{documentId}/compact`

Compact accumulated updates into a single snapshot. Called by the relay's background compaction worker.

```
POST /documents/{documentId}/compact
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

> **Who merges?** The relay (or a sidecar) performs the Yjs merge using Yrs FFI, then sends the merged binary to the provider. The provider only needs to atomically replace old updates with the new snapshot. This keeps the provider Yjs-unaware.

---

#### `POST /documents/{documentId}/versions`

Create a named version (explicit save point).

```
POST /documents/{documentId}/versions
Content-Type: application/json
Authorization: Bearer {relay-token}

{
  "label": "v2.1 — before refactor",
  "snapshot": {
    "data": "<base64>",
    "state_vector": "<base64>"
  },
  "created_by": "user-alice"
}
```

**Response — 201 Created:**
```json
{
  "version_id": "ver_abc123",
  "created_at": "2026-04-14T10:35:00Z"
}
```

---

#### `GET /documents/{documentId}/versions`

List available versions for the version history UI.

```
GET /documents/{documentId}/versions
Authorization: Bearer {relay-token}
```

**Response — 200 OK:**
```json
{
  "versions": [
    {
      "version_id": "ver_abc123",
      "label": "v2.1 — before refactor",
      "created_by": "user-alice",
      "created_at": "2026-04-14T10:35:00Z",
      "snapshot_size_bytes": 18432
    },
    {
      "version_id": "ver_def456",
      "label": "Initial draft",
      "created_by": "user-bob",
      "created_at": "2026-04-12T08:00:00Z",
      "snapshot_size_bytes": 2048
    }
  ]
}
```

---

#### `GET /documents/{documentId}/versions/{versionId}`

Load a specific version's snapshot (for diff view or restore).

```
GET /documents/{documentId}/versions/{versionId}
Authorization: Bearer {relay-token}
```

**Response — 200 OK:**
```json
{
  "version_id": "ver_abc123",
  "label": "v2.1 — before refactor",
  "snapshot": {
    "data": "<base64>",
    "state_vector": "<base64>"
  },
  "created_by": "user-alice",
  "created_at": "2026-04-14T10:35:00Z"
}
```

---

#### `DELETE /documents/{documentId}`

Delete all document data (cleanup, GDPR).

```
DELETE /documents/{documentId}
Authorization: Bearer {relay-token}
```

**Response — 204 No Content**

---

#### `POST /documents/{documentId}/lock` (Optional)

Acquire an advisory lock for exclusive operations like compaction. Prevents concurrent compaction from multiple relay instances.

```
POST /documents/{documentId}/lock
Content-Type: application/json
Authorization: Bearer {relay-token}

{
  "owner": "relay-instance-7",
  "ttl_seconds": 60,
  "purpose": "compaction"
}
```

**Response — 200 OK:**
```json
{ "lock_id": "lock_xyz", "expires_at": "2026-04-14T10:36:00Z" }
```

**Response — 409 Conflict:**
```json
{ "error": "already_locked", "owner": "relay-instance-3", "expires_at": "..." }
```

---

## Webhook: Provider → Relay (Optional)

For scenarios where the provider needs to push changes to the relay (e.g., document updated by an external system, or permissions revoked):

```
POST {relay_callback_url}/hooks/documents/{documentId}
Content-Type: application/json
X-Provider-Signature: hmac-sha256=...

{
  "event": "document.updated",     // or "document.deleted", "permissions.changed"
  "document_id": "project-123",
  "updates": [                     // optional: external updates to merge
    { "data": "<base64>" }
  ]
}
```

This enables the provider to inject updates from external sources (CI pipelines, API edits, batch imports) into active collaborative sessions.

---

## Go Relay: HTTP Client

```go
package storage

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

// HTTPProvider implements the storage client that calls the external provider.
type HTTPProvider struct {
    baseURL    string
    httpClient *http.Client
    authToken  string
}

type HTTPProviderConfig struct {
    BaseURL      string
    AuthToken    string
    LoadTimeout  time.Duration
    StoreTimeout time.Duration
}

func NewHTTPProvider(cfg HTTPProviderConfig) *HTTPProvider {
    return &HTTPProvider{
        baseURL:   cfg.BaseURL,
        authToken: cfg.AuthToken,
        httpClient: &http.Client{
            Timeout: cfg.StoreTimeout,
            Transport: &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 20,
                IdleConnTimeout:    90 * time.Second,
            },
        },
    }
}

// LoadRequest is the body sent to POST /documents/{id}/load
type LoadRequest struct {
    StateVector string `json:"state_vector,omitempty"`
}

// LoadResponse is returned by the provider.
type LoadResponse struct {
    Snapshot *SnapshotPayload  `json:"snapshot,omitempty"`
    Updates  []UpdatePayload   `json:"updates,omitempty"`
    Metadata *DocumentMetadata `json:"metadata,omitempty"`
}

type SnapshotPayload struct {
    Data        string    `json:"data"`         // base64
    StateVector string    `json:"state_vector"` // base64
    CreatedAt   time.Time `json:"created_at"`
    UpdateCount int       `json:"update_count"`
}

type UpdatePayload struct {
    Sequence  uint64    `json:"sequence"`
    Data      string    `json:"data"`      // base64
    ClientID  uint64    `json:"client_id"`
    CreatedAt time.Time `json:"created_at"`
}

type DocumentMetadata struct {
    Format      string `json:"format"`
    Language    string `json:"language"`
    CreatedBy   string `json:"created_by"`
    Permissions string `json:"permissions"` // "read-only" | "read-write"
}

func (p *HTTPProvider) Load(ctx context.Context, documentID string, stateVector []byte) (*LoadResponse, error) {
    body := LoadRequest{}
    if stateVector != nil {
        body.StateVector = base64.StdEncoding.EncodeToString(stateVector)
    }

    resp, err := p.doJSON(ctx, http.MethodPost,
        fmt.Sprintf("/documents/%s/load", url.PathEscape(documentID)),
        body,
    )
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    switch resp.StatusCode {
    case http.StatusNoContent:
        return &LoadResponse{}, nil // new document
    case http.StatusOK:
        var result LoadResponse
        if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
            return nil, fmt.Errorf("decoding load response: %w", err)
        }
        return &result, nil
    case http.StatusForbidden:
        return nil, ErrForbidden
    default:
        return nil, fmt.Errorf("unexpected status %d from provider", resp.StatusCode)
    }
}

// StoreRequest is the body sent to POST /documents/{id}/updates
type StoreRequest struct {
    Updates []UpdatePayload `json:"updates"`
}

type StoreResponse struct {
    Stored           int             `json:"stored"`
    DuplicatesIgnored int            `json:"duplicates_ignored"`
    Failed           []FailedUpdate  `json:"failed,omitempty"`
}

type FailedUpdate struct {
    Sequence uint64 `json:"sequence"`
    Error    string `json:"error"`
}

func (p *HTTPProvider) Store(ctx context.Context, documentID string, updates []UpdatePayload) (*StoreResponse, error) {
    body := StoreRequest{Updates: updates}

    resp, err := p.doJSON(ctx, http.MethodPost,
        fmt.Sprintf("/documents/%s/updates", url.PathEscape(documentID)),
        body,
    )
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result StoreResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decoding store response: %w", err)
    }

    return &result, nil
}

// doJSON is the shared HTTP helper with auth and content-type.
func (p *HTTPProvider) doJSON(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
    var buf bytes.Buffer
    if body != nil {
        if err := json.NewEncoder(&buf).Encode(body); err != nil {
            return nil, err
        }
    }

    req, err := http.NewRequestWithContext(ctx, method, p.baseURL+path, &buf)
    if err != nil {
        return nil, err
    }

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+p.authToken)
    req.Header.Set("X-Request-ID", generateRequestID())

    return p.httpClient.Do(req)
}
```

---

## Binary Transport Optimization

Base64 encoding inflates Yjs updates by ~33%. For high-throughput scenarios, the provider MAY support binary transport:

```
POST /documents/{documentId}/updates
Content-Type: application/x-yjs-updates
Authorization: Bearer {relay-token}
X-Update-Count: 3
X-Sequences: 1042,1043,1044

<raw binary: length-prefixed Yjs updates concatenated>
```

Wire format for the binary body:

```
┌──────────────────────────────────────────┐
│ Update 1                                  │
│ ┌──────────┬──────────┬─────────────────┐│
│ │ uint32   │ uint64   │ []byte          ││
│ │ length   │ sequence │ yjs update data ││
│ └──────────┴──────────┴─────────────────┘│
│ Update 2                                  │
│ ┌──────────┬──────────┬─────────────────┐│
│ │ uint32   │ uint64   │ []byte          ││
│ │ length   │ sequence │ yjs update data ││
│ └──────────┴──────────┴─────────────────┘│
│ ...                                       │
└──────────────────────────────────────────┘
```

The relay negotiates format via `Accept` headers. JSON+base64 is the default for simplicity; binary is opt-in for performance-sensitive deployments.

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
 │  2. POST /documents/{id}/updates               │
 │  3. On 202 → discard buffer, done              │
 │  4. On 207 → re-queue failed updates only      │
 │  5. On 5xx/timeout → re-queue all, backoff     │
 │     (100ms → 200ms → 400ms → 800ms → 1.6s)    │
 │  6. After 3 failures → log error, emit metric, │
 │     keep buffering (client y-indexeddb is the   │
 │     durability backstop)                        │
 └───────────────────────────────────────────────┘
```

### Room Lifecycle with HTTP Provider

```go
// Simplified room lifecycle

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
    documentID := chi.URLParam(r, "documentId")
    token := r.URL.Query().Get("token")

    // 1. Validate JWT (local, no HTTP call)
    claims, err := s.auth.ValidateToken(token)
    if err != nil {
        http.Error(w, "unauthorized", 401)
        return
    }

    // 2. Get or create room
    room := s.rooms.GetOrCreate(documentID, func() *Room {
        // Cold start: load from provider via HTTP
        ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
        defer cancel()

        state, err := s.provider.Load(ctx, documentID, nil)
        if err != nil {
            slog.Error("failed to load document", "doc", documentID, "err", err)
            return NewEmptyRoom(documentID) // degrade gracefully
        }

        room := NewRoom(documentID, state)

        // Check permissions from provider metadata
        if state.Metadata != nil && state.Metadata.Permissions == "read-only" {
            room.SetReadOnly(claims.UserID)
        }

        return room
    })

    // 3. Upgrade to WebSocket
    conn, err := s.upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }

    // 4. Add peer, sync initial state, enter relay loop
    peer := room.AddPeer(conn, claims)
    defer room.RemovePeer(peer)

    room.SyncInitialState(peer)
    room.RelayLoop(peer) // blocks until disconnect
}

// When the last peer leaves:
func (r *Room) onLastPeerLeft() {
    // Final flush — persist any remaining buffered updates
    r.flush()

    // Schedule room cleanup after idle timeout
    time.AfterFunc(r.config.IdleTimeout, func() {
        if r.PeerCount() == 0 {
            r.server.rooms.Remove(r.documentID)
        }
    })
}
```

---

## Health & Observability

The provider SHOULD expose a health endpoint for relay circuit-breaking:

```
GET /health
→ 200 { "status": "ok", "storage": "connected" }
→ 503 { "status": "degraded", "storage": "disconnected" }
```

The relay uses this for circuit-breaking — if the provider is unhealthy, the relay continues real-time collaboration (peers still sync via WebSocket) but stops attempting flushes until the provider recovers. Clients' y-indexeddb ensures no data loss during provider outages.

### Metrics the Relay Emits

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

For implementors building their own storage provider:

```
Required Endpoints:
  ✅ POST   /documents/{documentId}/load
  ✅ POST   /documents/{documentId}/updates
  ✅ DELETE  /documents/{documentId}

Recommended Endpoints:
  ⬜ POST   /documents/{documentId}/compact
  ⬜ POST   /documents/{documentId}/versions
  ⬜ GET    /documents/{documentId}/versions
  ⬜ GET    /documents/{documentId}/versions/{versionId}
  ⬜ GET    /health

Optional Endpoints:
  ⬜ POST   /documents/{documentId}/lock
  ⬜ POST   /documents/{documentId}/updates  (binary Content-Type)

Requirements:
  ✅ Idempotent writes (duplicate sequence numbers ignored)
  ✅ Concurrent-safe (multiple relay instances may call simultaneously)
  ✅ Auth via Bearer token
  ✅ JSON request/response bodies
  ✅ UTF-8 document IDs (URL-encoded in path)

Performance Targets:
  • /load    < 500ms p99 (cold start path)
  • /updates < 100ms p99 (async, but affects flush throughput)
  • /compact < 5s p99   (background, can be slow)
```

---

## OpenAPI Spec (Summary)

```yaml
openapi: 3.1.0
info:
  title: Collaborative Editor Storage Provider API
  version: 1.0.0
  description: >
    SPI contract for pluggable document storage backends.
    Implementors deploy this API and configure the relay with the base URL.

paths:
  /documents/{documentId}/load:
    post:
      summary: Load document state for room bootstrap
      parameters:
        - name: documentId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                state_vector: { type: string, format: base64 }
      responses:
        '200': { description: Document found, state returned }
        '204': { description: New document, no existing state }
        '403': { description: Access denied }

  /documents/{documentId}/updates:
    post:
      summary: Persist a batch of incremental updates
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [updates]
              properties:
                updates:
                  type: array
                  items:
                    type: object
                    required: [sequence, data, created_at]
                    properties:
                      sequence: { type: integer }
                      data: { type: string, format: base64 }
                      client_id: { type: integer }
                      created_at: { type: string, format: date-time }
      responses:
        '202': { description: All updates accepted }
        '207': { description: Partial success }

  /documents/{documentId}/compact:
    post:
      summary: Replace updates with merged snapshot

  /documents/{documentId}/versions:
    post:
      summary: Create a named version
    get:
      summary: List versions

  /documents/{documentId}/versions/{versionId}:
    get:
      summary: Load a specific version

  /documents/{documentId}:
    delete:
      summary: Delete all document data

  /health:
    get:
      summary: Provider health check
```
