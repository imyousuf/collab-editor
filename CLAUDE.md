# collab-editor

## Project Overview

A collaborative editor system with three components:
1. **Web Component** (`<multi-editor>`) — Lit-based custom element with Tiptap v3 (WYSIWYG) and CodeMirror 6 (source editing), using Yjs CRDTs for real-time collaboration.
2. **Go WebSocket Relay** — Stateless relay managing document rooms and broadcasting Yjs updates between peers. Persistence delegated to an external HTTP storage provider.
3. **Storage Provider SPI** — Pluggable REST API contract for document persistence (any language, any backend).

## Project Structure

```
docs/research/         — Architecture research and SPI contract specs
LICENSE                — Apache 2.0
```

## Key Architecture Concepts

- `Y.XmlFragment` is the canonical CRDT type (not `Y.Text`)
- WYSIWYG and source views use exclusive-view editing with serialization on switch
- The relay performs Yjs merges via Yrs FFI; the storage provider is CRDT-unaware
- Code blocks in rich text use decoration-based highlighting (lowlight/Shiki), not embedded CodeMirror

## Research Documents

- `docs/research/collab-editor-http-spi.md` — HTTP SPI contract, endpoint definitions, Go client code, binary transport, async flush pipeline
- `docs/research/collaborative-editor-architecture.md` — Editor evaluation, Yjs integration patterns, Markdown round-trip handling, view switching strategy, web component packaging

## Build & Development

_Not yet set up. Project is in research/design phase._

## Conventions

- Go code follows standard Go conventions (`gofmt`, `golint`)
- Frontend code will use TypeScript
- Commit messages: no AI/tool mentions in subject lines
