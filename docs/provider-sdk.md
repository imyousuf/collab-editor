# Storage Provider SDK Guide

The collab-editor relay delegates all document persistence to an external **storage provider** via a REST SPI. Provider SDKs are available in Go, TypeScript, and Python to handle the protocol details — you only implement `read`/`write` for your storage backend.

## How It Works

```
Browser ──WebSocket──> Relay ──HTTP REST──> Your Storage Provider
                                                 │
                                        Provider SDK handles:
                                        • Yjs diff extraction
                                        • Document state encoding
                                        • HTTP routing
                                        • Y.Doc caching
```

The relay batches Yjs updates from connected peers and periodically flushes them to your provider via `POST /documents/updates`. When a new peer joins, the relay calls `POST /documents/load` to bootstrap state.

## SPI Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/documents/load?path={id}` | POST | Load document content + stored Yjs updates |
| `/documents/updates?path={id}` | POST | Persist batched incremental Yjs updates |
| `/documents` | GET | List available documents (optional) |

See [HTTP SPI Contract](research/collab-editor-http-spi.md) for the full specification.

## Storage Strategies

Each SDK supports two storage strategies (choose one or both):

### 1. Raw Updates Mode (recommended)

Store the base64-encoded Yjs updates as-is in an append-only journal. On load, return them for replay. This is efficient, preserves full history, and requires no Yjs knowledge in your backend.

### 2. Resolved Text Mode

The SDK applies Yjs diffs internally and gives you the final plain text after each batch. You store the resolved text. Simple, but loses granular update history.

### 3. Both

Implement all methods. You get searchable resolved text AND efficient binary replay.

---

## Go SDK

**Package:** `github.com/imyousuf/collab-editor/pkg/spi`

The Go SDK provides the `Provider` interface and a ready-made `http.Handler`.

### Interface

```go
import "github.com/imyousuf/collab-editor/pkg/spi"

type Provider interface {
    Load(ctx context.Context, documentID string) (*LoadResponse, error)
    Store(ctx context.Context, documentID string, updates []UpdatePayload) (*StoreResponse, error)
    Health(ctx context.Context) (*HealthResponse, error)
}

// Optional interfaces
type OptionalList interface {
    ListDocuments(ctx context.Context) ([]DocumentListEntry, error)
}
```

### Framework Integration (net/http)

```go
import "github.com/imyousuf/collab-editor/pkg/spi"

type MyProvider struct { /* your storage */ }

func (p *MyProvider) Load(ctx context.Context, id string) (*spi.LoadResponse, error) {
    content, _ := readFromDB(ctx, id)
    updates, _ := loadUpdatesFromDB(ctx, id)
    return &spi.LoadResponse{
        Content:  content,
        MimeType: "text/markdown",
        Updates:  updates,
    }, nil
}

func (p *MyProvider) Store(ctx context.Context, id string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
    if err := appendUpdatesToDB(ctx, id, updates); err != nil {
        return nil, err
    }
    return &spi.StoreResponse{Stored: len(updates)}, nil
}

func (p *MyProvider) Health(ctx context.Context) (*spi.HealthResponse, error) {
    return &spi.HealthResponse{Status: "ok"}, nil
}

func main() {
    provider := &MyProvider{}
    handler := spi.NewHTTPHandler(provider)
    http.ListenAndServe(":8081", handler)
}
```

### Manual Integration

If you use your own router (chi, gin, mux), call the processing functions directly:

```go
// In your own handler:
resp, err := spi.ProcessLoadRequest(ctx, provider, documentID)
resp, err := spi.ProcessStoreRequest(ctx, provider, documentID, requestBody)
```

### Reference Implementation

The demo provider (`cmd/demo-provider/`) uses the Go SDK with filesystem storage. It implements `spi.Provider` and `spi.OptionalList`, delegates all SPI routing to `spi.NewHTTPHandler()`, and layers chi middleware for bearer auth on top.

---

## TypeScript SDK

**Package:** `@imyousuf/collab-editor-provider` (GitHub Packages)

The TypeScript SDK handles Yjs diff application via the `yjs` library, so your Node.js backend doesn't need to understand CRDTs.

### Install

```bash
npm install @imyousuf/collab-editor-provider
# Registry: https://npm.pkg.github.com
```

### Interface

```typescript
import { Provider, ContentResult } from '@imyousuf/collab-editor-provider';

interface Provider {
  readContent(documentId: string): Promise<ContentResult>;
  writeContent?(documentId: string, content: string, mimeType: string): Promise<void>;
  storeRawUpdates?(documentId: string, updates: UpdatePayload[]): Promise<void>;
  loadRawUpdates?(documentId: string): Promise<UpdatePayload[]>;
  listDocuments?(): Promise<DocumentListEntry[]>;
  onHealth?(): Promise<HealthResponse>;
}
```

### Express Integration

```typescript
import express from 'express';
import { createExpressRouter } from '@imyousuf/collab-editor-provider';

class MyProvider implements Provider {
  async readContent(documentId: string) {
    const text = await db.get(documentId);
    return { content: text ?? '', mimeType: 'text/plain' };
  }

  async writeContent(documentId: string, content: string, mimeType: string) {
    await db.set(documentId, content);
  }
}

const app = express();
app.use('/collab', createExpressRouter(new MyProvider()));
app.listen(8081);
```

### Standalone Server

```typescript
import { serve } from '@imyousuf/collab-editor-provider';
serve(new MyProvider(), { port: 8081 });
```

### Manual Integration

```typescript
import { ProviderProcessor } from '@imyousuf/collab-editor-provider';

const processor = new ProviderProcessor(myProvider);

// In your own controller:
const loadResult = await processor.processLoad(documentId);
const storeResult = await processor.processStore(documentId, updates);
```

### Engine Utilities

The SDK also exports low-level Yjs utilities if you need them:

```typescript
import {
  extractYjsUpdate,    // Strip y-websocket protocol header
  applyBase64Update,   // Apply base64 update to Y.Doc
  extractText,         // Get text from Y.Doc
  createDocWithContent,// Create seeded Y.Doc
  encodeDocState,      // Encode Y.Doc as base64
  DocCache,            // LRU cache for Y.Doc instances
} from '@imyousuf/collab-editor-provider';
```

---

## Python SDK

**Package:** `collab-editor-provider` (PyPI)

The Python SDK uses `pycrdt` (Rust-based Yjs bindings) for high-performance CRDT operations.

### Install

```bash
pip install collab-editor-provider

# With FastAPI support:
pip install collab-editor-provider[fastapi]
```

### Interface

```python
from collab_editor_provider import Provider, ContentResult

class Provider(ABC):
    @abstractmethod
    async def read_content(self, document_id: str) -> ContentResult: ...

    async def write_content(self, document_id: str, content: str, mime_type: str) -> None: ...
    async def store_raw_updates(self, document_id: str, updates: list[UpdatePayload]) -> None: ...
    async def load_raw_updates(self, document_id: str) -> list[UpdatePayload]: ...
    async def list_documents(self) -> list[DocumentListEntry]: ...
    async def on_health(self) -> HealthResponse: ...
```

### FastAPI Integration

```python
from fastapi import FastAPI
from collab_editor_provider import Provider, ContentResult, create_fastapi_router

class MyProvider(Provider):
    async def read_content(self, document_id: str) -> ContentResult:
        text = await db.get(document_id)
        return ContentResult(content=text or "", mime_type="text/plain")

    async def write_content(self, document_id: str, content: str, mime_type: str) -> None:
        await db.set(document_id, content)

app = FastAPI()
app.include_router(create_fastapi_router(MyProvider()), prefix="/collab")
```

### Standalone Server

```python
from collab_editor_provider import serve
serve(MyProvider(), port=8081)
```

### Manual Integration

```python
from collab_editor_provider import ProviderProcessor

processor = ProviderProcessor(MyProvider())

# In your own endpoint:
result = await processor.process_load(document_id)
result = await processor.process_store(document_id, updates)
```

### Engine Utilities

```python
from collab_editor_provider import (
    extract_yjs_update,     # Strip y-websocket protocol header
    apply_base64_update,    # Apply base64 update to pycrdt.Doc
    extract_text,           # Get text from Doc
    create_doc_with_content,# Create seeded Doc
    encode_doc_state,       # Encode Doc as base64
    DocCache,               # LRU cache for Doc instances
)
```

---

## gRPC Client (TypeScript)

**Package:** `@imyousuf/collab-editor-grpc` (GitHub Packages)

For service-to-service communication (e.g., a Socket.io bridge connecting to the relay via gRPC).

### Install

```bash
npm install @imyousuf/collab-editor-grpc
```

### Usage

```typescript
import { createRelayClient, checkHealth, PROTO_PATH } from '@imyousuf/collab-editor-grpc';

// Health check
const health = await checkHealth('localhost:50051');

// Join a document room
const client = createRelayClient('localhost:50051');
const stream = client.joinRoom();

// First message = join handshake
stream.write({ document_id: 'my-doc', payload: syncStep1 });

// Send Yjs updates
stream.write({ payload: yjsUpdate });

// Receive updates from other peers
stream.on('data', (msg) => {
  applyUpdate(doc, msg.payload);
});
```

The package bundles the proto file at `PROTO_PATH` for use with other gRPC toolchains.

---

## Testing

All SDKs share the same 10 JSON test fixtures (`test/fixtures/*.json`) generated from the canonical JavaScript `yjs` library. This ensures cross-language consistency:

| Fixture | Description |
|---------|-------------|
| 001-simple-insert | Single insert |
| 002-multiple-inserts | Sequential inserts |
| 003-delete | Insert then delete |
| 004-concurrent-edits | Two clients, no sync |
| 005-large-document | 100-line document |
| 006-empty-document | No updates |
| 007-unicode | Emoji and unicode |
| 008-rapid-edits | Character-by-character typing |
| 009-replace-content | Full content replacement |
| 010-with-initial-content | Edits on pre-existing content |

To regenerate fixtures: `npx tsx test/fixtures/generate-fixtures.ts`

### Running Tests

```bash
# Go SDK
go test ./pkg/spi/...

# TypeScript SDK
cd packages/provider-sdk-ts && npm test    # 41 tests

# Python SDK
cd packages/provider-sdk-py && pytest -v   # 52 tests

# gRPC client
cd packages/grpc-client-ts && npm test     # 4 tests

# Demo provider
go test ./internal/storagedemo/...         # 31 tests
```
