# collab-editor

## Project Overview

A collaborative editor system with five components:
1. **Web Component** (`<multi-editor>`) — Lit-based custom element with Tiptap v3 (WYSIWYG) and CodeMirror 6 (source editing), using Yjs CRDTs for real-time collaboration. Built-in configurable toolbar, status bar, formatting buttons, document switcher, collaborator presence, threaded inline comments, and Google-Docs-style Suggest Mode.
2. **Go Relay Server** — Manages document rooms and broadcasts Yjs updates between peers via WebSocket and gRPC transports. Redis pub/sub for multi-instance scaling. Persistence delegated to an external HTTP storage provider via the SDK; comments are proxied to an independent HTTP comments provider.
3. **Storage Provider SPI** — Pluggable, **Yjs-agnostic** REST API contract for document persistence (any language, any backend). Providers receive resolved plain text content on Store and return it on Load. No Yjs concepts in the SPI — the SDKs handle all CRDT internals. Document IDs passed via `?path=` query parameter.
4. **Comments Provider SPI** — Separate, **Yjs-free** REST API contract for threaded comments + suggestion persistence. A suggestion's `yjs_payload` is stored as an opaque base64 string; the provider never decodes it. Applying a suggestion on Accept is a frontend-only action (`Y.applyUpdate` on the base Y.Doc propagates the change via normal y-websocket sync).
5. **Provider SDKs** — Go (`pkg/spi`), TypeScript (`packages/provider-sdk-ts`), and Python (`packages/provider-sdk-py`) SDKs. Storage modules include Y.js engines for diff resolution + caching. Comments modules are plain REST + JSON — no Yjs dependency.

## Project Structure

```
cmd/relay/             — Go relay server entrypoint
cmd/demo-provider/     — Demo storage provider (reference implementation using Go SDK)
pkg/spi/               — Go provider SDK: Provider interface, ProviderProcessor, YDocEngine,
                         NewHTTPHandler(), CommentsProvider + NewCommentsHTTPHandler, types
  ydoc_engine.go       — YDocEngine interface (swappable Y.js abstraction)
  ygo_engine.go        — YDocEngine implementation backed by reearth/ygo
  processor.go         — ProviderProcessor: applies Y.js diffs, resolves content
  comments_types.go    — Comments SPI types (threads, comments, reactions,
                         suggestions, capabilities, poll changes)
  comments_provider.go — CommentsProvider + Optional{CommentEdit,Reactions,
                         Suggestions,Mentions,CommentPoll} interfaces
  comments_handler.go  — NewCommentsHTTPHandler — plain REST + JSON, no
                         Yjs engine; conditional routes by type assertion
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
internal/provider/     — HTTP clients for both SPIs
  client.go            — Storage Provider client
  comments_client.go   — Comments Provider client (used by the relay proxy)
internal/storagedemo/  — Demo filesystem-based storage + comments provider
  store.go             — FileStore implementing spi.Provider + OptionalList
                         + OptionalVersions + OptionalClientMappings
  comments_store.go    — CommentStore implementing spi.CommentsProvider +
                         every Optional* sub-interface
  mentions.go          — in-memory MentionDirectory for @-autocomplete
  server.go            — chi router: spi.NewHTTPHandler(store, processor)
                         + spi.NewCommentsHTTPHandler(commentStore) under /comments/*
                         + bearer auth
  config.go            — koanf config loader (adds comments.users)
  handler_compact.go   — Extra compact endpoint (not in SDK)
packages/              — SDK packages
  provider-sdk-ts/     — TypeScript provider SDK (@imyousuf/collab-editor-provider)
    src/engine.ts      — Yjs diff extraction, Y.Doc management, LRU cache
    src/provider.ts    — Provider interface + ProviderProcessor
    src/handler.ts     — Express router factory + standalone server
    src/types.ts       — SPI types (including VersionEntry, BlameSegment, ClientUserMapping)
    src/blame.ts       — computeBlameFromVersions (LCS-based line diff)
    src/comments/      — Comments SDK module (Yjs-free)
      types.ts         — CommentThread, Suggestion, CommentsCapabilities, ...
      provider.ts      — CommentsProvider interface + optional methods
      handler.ts       — createCommentsExpressRouter with conditional routes
      index.ts         — re-exports
  provider-sdk-py/     — Python provider SDK (collab-editor-provider)
    collab_editor_provider/engine.py    — pycrdt-based Yjs engine
    collab_editor_provider/provider.py  — Provider ABC + ProviderProcessor
    collab_editor_provider/handler.py   — FastAPI router factory
    collab_editor_provider/cache.py     — LRU DocCache
    collab_editor_provider/types.py     — Dataclass types (including version + blame types)
    collab_editor_provider/blame.py     — compute_blame_from_versions
    collab_editor_provider/comments/    — Comments SDK module (Yjs-free)
      types.py                          — dataclasses for all comment/suggest/mention types
      provider.py                       — CommentsProvider ABC + supports_* gating
      handler.py                        — create_comments_fastapi_router
  grpc-client-ts/      — gRPC TypeScript client (@imyousuf/collab-editor-grpc)
    src/index.ts       — createRelayClient(), checkHealth(), PROTO_PATH
    proto/relay.proto  — Bundled proto file
frontend/src/          — Lit web component (TypeScript)
  interfaces/          — IEditorBinding, IContentHandler, ICollaborationProvider,
                         IFormattingCapability, IBlameCapability, ICommentCapability,
                         ISuggestCapability, ToolbarConfig, StatusBarConfig, events
  bindings/            — DualMode, SourceOnly, PreviewSource + shared editor instances
                         (all three implement IBlameCapability + ICommentCapability)
  handlers/            — Markdown, HTML, PlainText content handlers
  collab/              — CollaborationProvider (y-websocket + SocketIOProvider),
                         TextBinding (Y.Text <-> Tiptap), BlameEngine (dual-mode),
                         BlameCoordinator, VersionCoordinator, VersionManager,
                         CommentEngine, CommentCoordinator, SuggestEngine,
                         diff-engine, blame-cm-extension, blame-tiptap-plugin,
                         comment-cm-extension, comment-tiptap-plugin
  toolbar/             — Built-in editor-toolbar, editor-status-bar, version-panel,
                         comment-panel, suggest-status Lit components
  react/               — React wrapper via @lit/react
  registry.ts          — EditorBindingFactory + MIME-type registration
  multi-editor.ts      — <multi-editor> Lit orchestrator (delegates to coordinators)
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
cd frontend && npm test                     # Run vitest (400 tests)

# Provider SDKs
cd packages/provider-sdk-ts && npm test     # 50 tests
cd packages/provider-sdk-py && pytest -v    # 60 tests
cd packages/grpc-client-ts && npm test      # 4 tests

# Docker (full stack)
docker compose up --build                   # Start all 3 services
make test-e2e                               # Run ATR browser tests
```

## Key Architecture Concepts

### SPI Contract (Yjs-agnostic)

- **`Store`** receives resolved plain text content AND raw Y.js diffs. The SDK resolves the diffs to content before calling the provider. Providers receive both and store however they see fit.
- **`Load`** returns only resolved plain text content. No Y.js updates, no CRDT binary. Providers just return the latest document text.
- The SDK handles all Yjs complexity internally — providers never see Y.Doc, Y.Text, or binary updates in the SPI contract.
- All three SDKs (Go, TS, Python) have Y.js engines that apply diffs and extract text:
  - Go SDK: `YDocEngine` interface backed by `reearth/ygo` (pure Go, swappable)
  - TS SDK: `yjs` library with `DocCache` LRU
  - Python SDK: `pycrdt` library with `DocCache` LRU

### Editor Architecture

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

### Multi-editor Coordinators

- `multi-editor.ts` is a thin lifecycle orchestrator that delegates domain concerns to coordinators
- `BlameCoordinator` — owns BlameEngine lifecycle, debounced Y.Doc update observer, blame toggle, mode switch re-push
- `VersionCoordinator` — owns VersionManager lifecycle, version panel events, version view mode, diff
- Coordinators use `attach(binding, ydoc, ...)` / `detach()` pattern for clean lifecycle management

### Scaling & Persistence

- Multi-instance scaling via Redis pub/sub: broker peer pattern adds a synthetic peer to each room that relays messages cross-instance without changing Room code
- Distributed flush lock (Redis SETNX + Lua release) ensures only one instance flushes per document
- The relay's flush loop sends raw Y.js diffs to the SDK. The SDK's `ProviderProcessor` resolves them to content via `YDocEngine` before calling the provider's `Store`
- On room creation, the relay loads content from the provider via `Load`. Since Load returns no Y.js updates, the room starts with empty history. The frontend seeds from `initialContent` when Y.Text is empty after a 200ms settle window

### Demo Provider Storage

- The demo provider implements `spi.Provider`, `spi.OptionalList`, `spi.OptionalVersions`, and `spi.OptionalClientMappings`, using `spi.NewHTTPHandler(store, processor)` for SPI routing
- Store writes resolved content to `.versions/{docID}/{versionID}/{docName}` and appends a `VERSION:` pointer to the journal file
- Load reads the last `VERSION:` pointer from the journal and returns that file's content. Falls back to the seed file when no versions exist
- Seed files are never modified — they serve as the initial baseline

### Version History & Blame

- Version history: SPI is Yjs-agnostic — `VersionEntry` returns plain text content, not CRDT binary. SDKs compute blame from version content chain (LCS-based line diff). Demo provider stores versions as JSON files in `.versions/{docID}/`
- Blame has two modes: **live blame** (captures Y.Doc update events in localStorage, resets on refresh) and **version blame** (read-only, blame segments from SPI). Developer controls which modes are available via `liveBlameEnabled`/`versionBlameEnabled` config
- `IBlameCapability` is an optional interface — `DualModeBinding`, `SourceOnlyBinding`, and `PreviewSourceBinding` implement it. Checked via `isBlameCapable()` type guard
- Relay proxies version/client-mapping API calls to the provider via `/api/documents/versions`, `/api/documents/clients` endpoints

### Comments & Suggest Mode

- **Comments Provider is independent from Storage Provider.** Separate SPI, separate URL, separate auth. The relay config gains a `comments.provider_url` section; when omitted, `/api/documents/comments/*` routes return 503 and the frontend reports `commentsSupported: false` via `/api/capabilities`.
- **Comments SDKs are Yjs-free.** Suggestion `yjs_payload` is stored as an opaque base64 string. No `ProviderProcessor` / `YDocEngine` involvement. Providers can be written in any language with zero Yjs dependency.
- **Capability-driven features.** Provider's `GET /capabilities` declares `comment_edit`, `comment_delete`, `reactions[]`, `mentions`, `suggestions`, `max_comment_size`, `poll_supported`. The editor adapts UI to whatever the provider supports; unsupported features produce no UI.
- **Feature-flag dependency.** `suggestEnabled` is forced false when `commentsEnabled` is false — suggestions cannot exist without comments. Three gates stack: relay config (deployment), provider capabilities, client `CollaborationConfig`.
- **Anchors** use `Y.RelativePosition` internally (robust to concurrent edits) and `{start, end, quoted_text}` on the wire. Orphaned threads (anchor lost after content changes) stay visible in the panel but without inline decoration.
- **Suggest Mode** is a toggle. While active, the SuggestEngine creates a local Y.Doc buffer seeded from the base Y.Text. Editor writes route into the buffer; remote base updates replay onto the buffer so the local suggestion auto-rebases. On Submit, the buffer's delta relative to the enable-time state vector is encoded as the opaque `yjs_payload` + structured `SuggestionView` (summary + before/after + operation list).
- **Accept** is a frontend-only action: `Y.applyUpdate(baseDoc, decodeBase64(yjs_payload))`. The Y.Text mutation propagates via normal y-websocket sync — peers see it as if the reviewer had typed it. The comments provider only records the status change (PATCH on decision).
- `ICommentCapability` + `ISuggestCapability` are optional interfaces; all three bindings implement ICommentCapability, and the SuggestEngine is lifecycle-owned by `CommentCoordinator`.
- Polling: per-document, focus-gated. `document.hasFocus()` skips network calls. Poll-driven Y.Map mutations are tagged with a `POLL_ORIGIN` so the debounced persistence loop doesn't echo them back to the SPI.

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
- `YDocEngine` interface in Go SDK abstracts the Y.js implementation — swap `reearth/ygo` for another library by implementing `YDocEngine`
