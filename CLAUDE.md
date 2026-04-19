# collab-editor

## Project Overview

A collaborative editor system with three components:
1. **Web Component** (`<multi-editor>`) — Lit-based custom element with Tiptap v3 (WYSIWYG) and CodeMirror 6 (source editing), using Yjs CRDTs for real-time collaboration.
2. **Go WebSocket Relay** — Stateless relay managing document rooms and broadcasting Yjs updates between peers. Persistence delegated to an external HTTP storage provider.
3. **Storage Provider SPI** — Pluggable REST API contract for document persistence (any language, any backend).

## Project Structure

```
cmd/relay/             — Go relay server entrypoint
cmd/provider/          — Demo storage provider entrypoint
pkg/spi/               — Shared SPI types (public, importable by external providers)
internal/relay/        — Relay server: transport, rooms, peers, buffer, flush, metrics
internal/provider/     — HTTP client for the storage provider SPI
internal/storagedemo/  — Demo filesystem-based storage provider
frontend/src/          — Lit web component (TypeScript)
config/                — Default YAML configs for relay and provider
docker/                — Dockerfiles and nginx config
examples/basic/        — Docker Compose example with seed documents
examples/react-app/    — React integration example
tests/e2e/             — ATR browser test files
docs/research/         — Architecture research and SPI contract specs
```

## Build & Development

```bash
# Go backend
make build              # Build relay + provider binaries
make test               # Run Go tests with race detector
make test-fast          # Run Go tests without race detector
make vet                # Run go vet

# Frontend
cd frontend && npm install && npm run dev   # Dev server on :5173
cd frontend && npm run build                # Production build

# Docker (full stack)
docker compose up --build                   # Start all 3 services
make test-e2e                               # Run ATR browser tests
```

## Key Architecture Concepts

- `Y.XmlFragment` is the canonical CRDT type (not `Y.Text`)
- WYSIWYG and source views use exclusive-view editing with serialization on switch
- The relay uses `github.com/skyterra/y-crdt` for server-side Yjs operations
- The WebSocket transport is pluggable via the `Transport` interface in `internal/relay/transport.go`
- Code blocks in rich text use decoration-based highlighting (lowlight), not embedded CodeMirror
- Document IDs are validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` to prevent path traversal

## Conventions

- Go code follows standard Go conventions (`gofmt`, `go vet`)
- Frontend code uses TypeScript with strict mode
- Commit messages: no AI/tool mentions in subject lines
- Use `koanf` for config (not viper)
- Use `coder/websocket` (not `nhooyr.io/websocket` which is deprecated)
- Prometheus metrics use a per-instance registry (not global) to support testing
