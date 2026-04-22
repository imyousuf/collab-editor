# Storage Provider SDK Guide

The collab-editor relay delegates all document persistence to an external **storage provider** via a REST SPI. Provider SDKs are available in Go, TypeScript, and Python to handle the protocol details — you only implement `read`/`write` for your storage backend.

**The SPI is fully Yjs-agnostic.** All three SDKs contain built-in Y.js engines that resolve CRDT diffs internally. Your provider never sees Y.Doc, Y.Text, or binary updates — it only receives and returns plain text content strings.

## How It Works

```
Browser ──WebSocket──> Relay ──HTTP REST──> Provider SDK ──> Your Provider
                                                │                  │
                                       SDK handles:        You implement:
                                       • Y.js diff           • read(id) → text
                                         resolution          • write(id, text)
                                       • Y.Doc caching
                                       • HTTP routing
                                       • MIME detection
```

The relay batches Y.js updates from connected peers and periodically flushes them to your provider via `POST /documents/updates`. The SDK intercepts these requests, applies the Y.js diffs to a cached Y.Doc, resolves the document to plain text, and passes the resolved content to your provider's write method. When a new peer joins, the relay calls `POST /documents/load` — the SDK calls your provider's read method and returns the plain text content.

## SPI Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/documents/load?path={id}` | POST | Load latest document content (plain text) |
| `/documents/updates?path={id}` | POST | Persist document content (SDK resolves Y.js diffs to text) |
| `/documents` | GET | List available documents (optional) |
| `/documents/versions?path={id}` | GET/POST | Version history (optional) |
| `/documents/clients?path={id}` | GET/POST | Client-user mappings for blame (optional) |

See [HTTP SPI Contract](research/collab-editor-http-spi.md) for the full specification.

## Provider Model

All three SDKs follow the same pattern: the SDK resolves Y.js diffs to plain text content, and your provider only deals with content strings.

**On Store:** The relay sends raw Y.js updates. The SDK applies them to a cached Y.Doc, extracts the resolved document text, and calls your provider's write method with the plain text content and MIME type.

**On Load:** The SDK calls your provider's read method, which returns the latest document text and MIME type. No Y.js binary data is involved.

Your provider implementation is a simple read/write interface:
- `read(documentId)` -- returns the current document text and MIME type
- `write(documentId, content, mimeType)` -- persists the resolved text

The SDKs also support optional raw update storage (append-only journal) for providers that want to retain Y.js update history alongside the resolved content.

---

## Go SDK

**Package:** `github.com/imyousuf/collab-editor/pkg/spi`

The Go SDK provides the `Provider` interface, a `ProviderProcessor` that resolves Y.js diffs via a pluggable `YDocEngine`, and a ready-made `http.Handler`.

### Provider Interface

Your provider implements simple read/write operations for plain text content:

```go
import "github.com/imyousuf/collab-editor/pkg/spi"

type Provider interface {
    // Load returns the latest resolved document content (plain text).
    Load(ctx context.Context, documentID string) (*LoadResponse, error)

    // Store persists the document state. Receives the resolved content
    // (latest full text) alongside raw Y.js updates. The SDK populates
    // req.Content and req.MimeType before calling this method.
    Store(ctx context.Context, documentID string, req *StoreRequest) (*StoreResponse, error)

    // Health returns the provider's health status.
    Health(ctx context.Context) (*HealthResponse, error)
}

// Optional interfaces for extended capabilities
type OptionalList interface {
    ListDocuments(ctx context.Context) ([]DocumentListEntry, error)
}
type OptionalVersions interface {
    ListVersions(ctx context.Context, documentID string) ([]VersionListEntry, error)
    CreateVersion(ctx context.Context, documentID string, req *CreateVersionRequest) (*VersionListEntry, error)
    GetVersion(ctx context.Context, documentID string, versionID string) (*VersionEntry, error)
}
type OptionalClientMappings interface {
    GetClientMappings(ctx context.Context, documentID string) ([]ClientUserMapping, error)
    StoreClientMappings(ctx context.Context, documentID string, mappings []ClientUserMapping) error
}
```

The `LoadResponse` contains `Content` (string) and `MimeType` (string) -- no Y.js binary fields. The `StoreRequest` includes `Content` and `MimeType` fields that the SDK populates with the resolved plain text before calling your provider.

### YDocEngine Interface

The Go SDK uses a `YDocEngine` interface (backed by `reearth/ygo`) to resolve Y.js diffs. The `ProviderProcessor` creates one engine per document and applies raw updates to extract resolved text:

```go
type YDocEngine interface {
    ApplyUpdate(update []byte) error
    GetText(name string) string
    InsertText(name string, content string)
    EncodeStateAsUpdate() []byte
}

type YDocEngineFactory func() YDocEngine
```

### Framework Integration (net/http)

```go
import "github.com/imyousuf/collab-editor/pkg/spi"

type MyProvider struct { /* your storage */ }

func (p *MyProvider) Load(ctx context.Context, id string) (*spi.LoadResponse, error) {
    content, _ := readFromDB(ctx, id)
    return &spi.LoadResponse{
        Content:  content,
        MimeType: "text/markdown",
    }, nil
}

func (p *MyProvider) Store(ctx context.Context, id string, req *spi.StoreRequest) (*spi.StoreResponse, error) {
    // req.Content contains the resolved plain text (populated by the SDK)
    // req.MimeType contains the document MIME type
    if err := writeContentToDB(ctx, id, req.Content, req.MimeType); err != nil {
        return nil, err
    }
    return &spi.StoreResponse{Stored: len(req.Updates)}, nil
}

func (p *MyProvider) Health(ctx context.Context) (*spi.HealthResponse, error) {
    return &spi.HealthResponse{Status: "ok"}, nil
}

func main() {
    provider := &MyProvider{}
    // Create the processor with a YDocEngine factory for Y.js resolution
    processor := spi.NewProviderProcessor(provider, spi.NewYgoEngine, "source")
    // Pass the processor to the HTTP handler so it resolves diffs before calling Store
    handler := spi.NewHTTPHandler(provider, processor)
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

The demo provider (`cmd/demo-provider/`) uses the Go SDK with filesystem storage. It implements `spi.Provider`, `spi.OptionalList`, `spi.OptionalVersions`, and `spi.OptionalClientMappings`, delegates all SPI routing to `spi.NewHTTPHandler()`, and layers chi middleware for bearer auth on top. It stores resolved content in versioned files: `.versions/{docId}/{versionId}/{filename}`, with `VERSION:` pointers in a journal file. Load reads the latest VERSION pointer from the journal, falling back to the seed file.

---

## TypeScript SDK

**Package:** `@imyousuf/collab-editor-provider` (GitHub Packages)

The TypeScript SDK resolves Y.js diffs internally via the `yjs` library. Your Node.js backend never touches CRDTs -- it only reads and writes plain text content.

### Install

```bash
npm install @imyousuf/collab-editor-provider
# Registry: https://npm.pkg.github.com
```

### Interface

The core interface requires only `readContent()` and optionally `writeContent()`. The SDK handles all Y.js resolution:

```typescript
import { Provider, ContentResult } from '@imyousuf/collab-editor-provider';

interface Provider {
  /** Read the current document text from your storage */
  readContent(documentId: string): Promise<ContentResult>;

  /** Write the resolved text back to your storage (called after SDK resolves diffs) */
  writeContent?(documentId: string, content: string, mimeType: string): Promise<void>;

  /** Optional: store raw Y.js updates alongside resolved content */
  storeRawUpdates?(documentId: string, updates: UpdatePayload[]): Promise<void>;

  /** Optional: load raw Y.js updates for replay (append-only journal) */
  loadRawUpdates?(documentId: string): Promise<UpdatePayload[]>;

  /** Optional: list available documents */
  listDocuments?(): Promise<DocumentListEntry[]>;

  /** Optional: custom health check */
  onHealth?(): Promise<HealthResponse>;
}
```

The `ProviderProcessor` applies Y.js diffs to a cached Y.Doc, extracts the resolved text, and calls your `writeContent()` with the plain text result. On load, it calls your `readContent()` and returns the content directly.

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

The SDK also exports low-level Y.js utilities for advanced use cases:

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

The Python SDK resolves Y.js diffs internally via `pycrdt` (Rust-based Y.js bindings). Your Python backend only reads and writes plain text content.

### Install

```bash
pip install collab-editor-provider

# With FastAPI support:
pip install collab-editor-provider[fastapi]
```

### Interface

The core interface requires only `read_content()` and optionally `write_content()`. The SDK handles all Y.js resolution:

```python
from collab_editor_provider import Provider, ContentResult

class Provider(ABC):
    @abstractmethod
    async def read_content(self, document_id: str) -> ContentResult:
        """Read the current document text from your storage."""
        ...

    async def write_content(self, document_id: str, content: str, mime_type: str) -> None:
        """Write the resolved text back to your storage (called after SDK resolves diffs)."""
        ...

    async def store_raw_updates(self, document_id: str, updates: list[UpdatePayload]) -> None:
        """Optional: store raw Y.js updates alongside resolved content."""
        ...

    async def list_documents(self) -> list[DocumentListEntry]: ...
    async def on_health(self) -> HealthResponse: ...
```

The `ProviderProcessor` applies Y.js diffs to a cached `pycrdt.Doc`, extracts the resolved text, and calls your `write_content()` with the plain text result. On load, it calls your `read_content()` and returns the content directly.

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

The SDK also exports low-level Y.js utilities for advanced use cases:

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
