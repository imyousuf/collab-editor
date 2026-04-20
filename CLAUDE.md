# collab-editor

## Project Overview

A collaborative editor system with four components:
1. **Web Component** (`<multi-editor>`) — Lit-based custom element with Tiptap v3 (WYSIWYG) and CodeMirror 6 (source editing), using Yjs CRDTs for real-time collaboration. Built-in configurable toolbar, status bar, formatting buttons, document switcher, and collaborator presence.
2. **Go Relay Server** — Manages document rooms and broadcasts Yjs updates between peers via WebSocket and gRPC transports. Redis pub/sub for multi-instance scaling. Persistence delegated to an external HTTP storage provider.
3. **Storage Provider SPI** — Pluggable REST API contract for document persistence (any language, any backend). Document IDs passed via `?path=` query parameter.
4. **Provider SDKs** — Go (`pkg/spi`), TypeScript (`packages/provider-sdk-ts`), and Python (`packages/provider-sdk-py`) SDKs that handle Yjs diff application, HTTP routing, and Y.Doc caching. Implementors only write `read`/`write` for their storage.

## Project Structure

```
cmd/relay/             — Go relay server entrypoint
cmd/demo-provider/     — Demo storage provider (reference implementation using Go SDK)
pkg/spi/               — Go provider SDK: Provider interface, NewHTTPHandler(), types
pkg/relayapi/v1/       — gRPC proto definition + generated Go stubs
internal/relay/        — Relay server: transport, rooms, peers, buffer, flush, metrics
  transport.go         — Transport/Conn/ConnectionHandler interfaces
  ws_transport.go      — WebSocket transport (coder/websocket)
  grpc_transport.go    — gRPC bidirectional streaming transport
  broker.go            — MessageBroker interface (noop + Redis implementations)
  broker_conn.go       — Conn adapter for Redis pub/sub broker peer
  redis_broker.go      — Redis pub/sub implementation
  flush_lock.go        — FlushLock interface (local + Redis implementations)
  redis_flush_lock.go  — Redis SETNX distributed flush lock
internal/provider/     — HTTP client for the storage provider SPI
internal/storagedemo/  — Demo filesystem-based storage provider
  store.go             — FileStore implementing spi.Provider + OptionalList
                         + OptionalVersions + OptionalClientMappings
  server.go            — chi router: spi.NewHTTPHandler() + bearer auth + compact endpoint
  config.go            — koanf config loader
  handler_compact.go   — Extra compact endpoint (not in SDK)
packages/              — SDK packages
  provider-sdk-ts/     — TypeScript provider SDK (@imyousuf/collab-editor-provider)
    src/engine.ts      — Yjs diff extraction, Y.Doc management, LRU cache
    src/provider.ts    — Provider interface + ProviderProcessor
    src/handler.ts     — Express router factory + standalone server
    src/types.ts       — SPI types (including VersionEntry, BlameSegment, ClientUserMapping)
    src/blame.ts       — computeBlameFromVersions (LCS-based line diff)
  provider-sdk-py/     — Python provider SDK (collab-editor-provider)
    collab_editor_provider/engine.py    — pycrdt-based Yjs engine
    collab_editor_provider/provider.py  — Provider ABC + ProviderProcessor
    collab_editor_provider/handler.py   — FastAPI router factory
    collab_editor_provider/cache.py     — LRU DocCache
    collab_editor_provider/types.py     — Dataclass types (including version + blame types)
    collab_editor_provider/blame.py    — compute_blame_from_versions
  grpc-client-ts/      — gRPC TypeScript client (@imyousuf/collab-editor-grpc)
    src/index.ts       — createRelayClient(), checkHealth(), PROTO_PATH
    proto/relay.proto  — Bundled proto file
frontend/src/          — Lit web component (TypeScript)
  interfaces/          — IEditorBinding, IContentHandler, ICollaborationProvider,
                         IFormattingCapability, IBlameCapability, ToolbarConfig, StatusBarConfig, events
  bindings/            — DualMode, SourceOnly, PreviewSource + shared editor instances
                         (all three implement IBlameCapability)
  handlers/            — Markdown, HTML, PlainText content handlers
  collab/              — CollaborationProvider (y-websocket + SocketIOProvider),
                         TextBinding (Y.Text <-> Tiptap), BlameEngine (dual-mode),
                         VersionManager, diff-engine, blame-cm-extension, blame-tiptap-plugin
  toolbar/             — Built-in editor-toolbar and editor-status-bar Lit components
  react/               — React wrapper via @lit/react
  registry.ts          — EditorBindingFactory + MIME-type registration
  multi-editor.ts      — <multi-editor> Lit orchestrator
test/fixtures/         — 10 shared JSON test fixtures generated from canonical yjs
config/                — Default YAML configs for relay and provider
docker/                — Dockerfiles and nginx config
examples/basic/        — Docker Compose example with seed documents
examples/react-app/    — React integration example
tests/e2e/             — ATR browser test files
docs/                  — Provider SDK guide and SPI contract spec
.github/workflows/     — CI, npm publish, PyPI publish, Docker publish, proto lint/push
buf.yaml, buf.gen.yaml — Buf proto config and codegen
```

## Build & Development

```bash
# Go backend
make build              # Build relay + provider binaries
make test               # Run Go tests with race detector
make test-fast          # Run Go tests without race detector
make vet                # Run go vet
make proto              # Generate gRPC stubs (requires buf CLI)

# Frontend
cd frontend && npm install && npm run dev   # Dev server on :5173
cd frontend && npm run build                # Production build (tsc + vite)
cd frontend && npm test                     # Run vitest (299 tests)

# Provider SDKs
cd packages/provider-sdk-ts && npm test     # 51 tests
cd packages/provider-sdk-py && pytest -v    # 62 tests
cd packages/grpc-client-ts && npm test      # 4 tests

# Docker (full stack)
docker compose up --build                   # Start all 3 services
make test-e2e                               # Run ATR browser tests
```

## Key Architecture Concepts

- `Y.Text` is the canonical CRDT type — all modes (WYSIWYG, source, preview) bind to the same Y.Text
- DualModeBinding keeps both Tiptap (WYSIWYG) and CodeMirror (source) mounted simultaneously, toggling visibility on mode switch. Both bind to Y.Text: CodeMirror via yCollab, Tiptap via TextBinding (diff-based sync)
- The relay is a stateless broadcast relay — it does NOT maintain server-side Y.Docs. Peers sync directly through it via the y-websocket protocol
- The transport layer is pluggable via the `Transport` interface in `internal/relay/transport.go` — WebSocket and gRPC both implement it
- The `Conn` interface abstracts read/write/close — grpcConn, wsConn, and brokerConn all implement it
- y-codemirror.next (yCollab) only observes Y.Text *changes*, not pre-existing content. Content must be seeded AFTER CodeMirror mounts
- Initialization is serialized via a promise chain (`_initChain`) to prevent race conditions from Lit's async reactive lifecycle
- Document IDs are validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` to prevent path traversal
- MIME-type registry pattern: `EditorBindingFactory` maps MIME types to binding constructors (DualModeBinding, SourceOnlyBinding, PreviewSourceBinding) and content handlers
- `IFormattingCapability` is an optional interface — only DualModeBinding implements it. Checked via `isFormattingCapable()` type guard
- CSS custom properties (`--me-*`) define all visual values. Dark mode via `:host([theme="dark"])`. `::part()` exports on all structural sections
- Multi-instance scaling via Redis pub/sub: broker peer pattern adds a synthetic peer to each room that relays messages cross-instance without changing Room code
- Distributed flush lock (Redis SETNX + Lua release) ensures only one instance flushes per document
- Provider SDKs support dual storage: raw updates mode (append-only journal) and/or resolved text mode (SDK applies Yjs diffs, gives you plain text)
- The demo provider implements `spi.Provider`, `spi.OptionalList`, `spi.OptionalVersions`, and `spi.OptionalClientMappings`, using `spi.NewHTTPHandler()` for SPI routing with chi middleware for bearer auth
- Version history: SPI is Yjs-agnostic — `VersionEntry` returns plain text content, not CRDT binary. SDKs compute blame from version content chain (LCS-based line diff). Demo provider stores versions as JSON files in `.versions/{docID}/`
- Blame has two modes: **live blame** (captures Y.Doc update events in localStorage, resets on refresh) and **version blame** (read-only, blame segments from SPI). Developer controls which modes are available via `liveBlameEnabled`/`versionBlameEnabled` config
- `IBlameCapability` is an optional interface — `DualModeBinding`, `SourceOnlyBinding`, and `PreviewSourceBinding` implement it. Checked via `isBlameCapable()` type guard
- Relay proxies version/client-mapping API calls to the provider via `/api/documents/versions`, `/api/documents/clients` endpoints

## Conventions

- Go code follows standard Go conventions (`gofmt`, `go vet`)
- Frontend code uses TypeScript with strict mode
- Commit messages: no AI/tool mentions in subject lines
- Use `koanf` for config (not viper)
- Use `coder/websocket` (not `nhooyr.io/websocket` which is deprecated)
- Prometheus metrics use a per-instance registry (not global) to support testing
- Proto stubs generated with `buf generate` and committed to the repo
- npm packages published to GitHub Packages (`@imyousuf/collab-editor`, `@imyousuf/collab-editor-provider`, `@imyousuf/collab-editor-grpc`)
- Python package published to PyPI as `collab-editor-provider`
- Docker images published to GHCR as `ghcr.io/imyousuf/collab-editor/{relay,demo-provider}`
- CI runs on every push: Go tests + vet, frontend build + tests, all SDK tests
- CSS custom properties use `--me-` prefix (me = multi-editor)
- All provider SDKs share the same 10 JSON test fixtures (`test/fixtures/`) generated from canonical yjs for cross-language consistency
- SPI endpoints use `?path=` query parameter for document IDs (not path segments)
