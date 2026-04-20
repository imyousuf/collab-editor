# collab-editor

A real-time collaborative editor built on Yjs CRDTs, packaged as a framework-agnostic web component with a Go relay server.

## Features

- **WYSIWYG + Source editing** — Tiptap v3 and CodeMirror 6 bound to the same Yjs CRDT, with live mode switching
- **Real-time collaboration** — Multiple users edit simultaneously with presence indicators
- **11 MIME types** — Markdown, HTML, JSX/TSX (with preview), JavaScript, TypeScript, Python, CSS, JSON, YAML, plain text
- **Configurable UI** — Built-in toolbar with formatting buttons, status bar with presence avatars, document switcher
- **60+ CSS custom properties** — Full theming with `--me-*` variables, `::part()` exports, dark mode, slot escape hatches
- **Pluggable storage** — REST SPI for persistence (any language, any backend)
- **Multi-instance scaling** — Redis pub/sub for horizontal scaling on Cloud Run / Kubernetes
- **Dual transport** — WebSocket (direct browser) and gRPC (service-to-service, e.g., Socket.io bridge)
- **Socket.io support** — Frontend `SocketIOProvider` for environments that use Socket.io instead of raw WebSocket

## Quick Start

```bash
docker compose up --build
# Open http://localhost:3000
```

## Architecture

```
Browser ──WebSocket──> Go Relay ──HTTP──> Storage Provider (SPI)
                           │
                      Redis pub/sub
                    (multi-instance)

Browser ──Socket.io──> ws-gateway ──gRPC──> Go Relay
```

**Three components:**

| Component | Language | Purpose |
|-----------|----------|---------|
| `<multi-editor>` | TypeScript (Lit) | Web component with Tiptap + CodeMirror + Yjs |
| Relay Server | Go | WebSocket + gRPC relay, room management, buffer/flush |
| Storage Provider | Any | REST SPI for document persistence |

The relay is stateless — it does NOT maintain server-side Y.Docs. Peers sync directly through it via the y-websocket protocol. All persistence is delegated to the storage provider via HTTP REST.

## Usage

### Web Component

```html
<multi-editor id="editor" theme="light" placeholder="Start writing..."></multi-editor>

<script type="module">
  const editor = document.querySelector('multi-editor');
  await editor.configure({
    mimeType: 'text/markdown',
    collaboration: {
      enabled: true,
      roomName: 'my-doc',
      providerUrl: 'ws://localhost:8080/ws',
      user: { name: 'Alice', color: '#e06c75', image: '/avatars/alice.png' },
    },
    initialContent: '# Hello World',
  });
</script>
```

### React

```tsx
import { MultiEditorReact } from '@imyousuf/collab-editor/react';

<MultiEditorReact
  mode="wysiwyg"
  collaboration={{
    enabled: true,
    transport: 'socketio',          // or 'websocket' (default)
    providerUrl: '/collab',
    roomName: 'my-doc',
    socketAuth: { token: accessToken },
    user: { name: 'Alice', color: '#e06c75' },
  }}
  toolbarConfig={{ groups: ['mode-switcher', 'formatting', 'document-switcher'] }}
  documents={[{ id: 'readme.md', name: 'readme.md' }]}
  currentDocumentId="readme.md"
  onDocumentChange={(e) => loadDocument(e.detail.documentId)}
/>
```

### CSS Theming

```css
multi-editor {
  --me-bg: #ffffff;
  --me-color: #1a1a1a;
  --me-toolbar-bg: #f8f9fa;
  --me-toolbar-button-active-bg: #333;
  --me-source-font-family: 'JetBrains Mono', monospace;
  --me-status-connected-color: #22c55e;
}

/* Or use ::part() for structural styling */
multi-editor::part(toolbar) { border-bottom: 2px solid var(--brand); }
multi-editor::part(editor-area) { padding: 2rem; }

/* Or replace entirely with slots */
<multi-editor>
  <div slot="toolbar">My custom toolbar</div>
</multi-editor>
```

### Supported MIME Types

| MIME Type | Modes | Binding |
|-----------|-------|---------|
| `text/markdown` | wysiwyg, source | DualModeBinding |
| `text/html` | wysiwyg, source | DualModeBinding |
| `text/jsx`, `text/tsx` | preview, source | PreviewSourceBinding |
| `text/javascript`, `text/typescript`, `text/x-python`, `text/css`, `application/json`, `text/yaml`, `text/plain` | source | SourceOnlyBinding |

## Configuration

### Toolbar

```js
editor.toolbarConfig = {
  visible: true,                      // hide with false
  position: 'top',                    // 'top' or 'bottom'
  groups: ['mode-switcher', 'formatting', 'document-switcher'],
  formattingCommands: ['bold', 'italic', 'heading1', 'bulletList', 'link'],
  showModeSwitcher: true,
  showDocumentSwitcher: true,
};
```

### Status Bar

```js
editor.statusBarConfig = {
  visible: true,
  showConnectionStatus: true,         // green/yellow/red dot
  showUserIdentity: true,             // avatar + name
  showPresence: true,                 // collaborator avatars
};
```

### Relay Server

Environment variables or `config/relay.yaml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `COLLAB_SERVER_ADDR` | `:8080` | WebSocket listen address |
| `COLLAB_GRPC_ENABLED` | `false` | Enable gRPC transport |
| `COLLAB_GRPC_ADDR` | `:50051` | gRPC listen address |
| `COLLAB_REDIS_ENABLED` | `false` | Enable Redis pub/sub for multi-instance |
| `COLLAB_REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `COLLAB_STORAGE_PROVIDER_URL` | `http://localhost:8081` | Storage provider base URL |

## Storage Provider SPI

The relay communicates with the storage provider via REST. Required endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/documents/load?path={documentId}` | POST | Load document state for room bootstrap |
| `/documents/updates?path={documentId}` | POST | Persist batched incremental updates |

See [docs/research/collab-editor-http-spi.md](docs/research/collab-editor-http-spi.md) for the full SPI contract.

## Development

```bash
# Go backend
make build              # Build relay + provider binaries
make test               # Run Go tests with race detector
make test-fast          # Run Go tests without race detector
make vet                # Run go vet
make proto              # Generate gRPC stubs (requires buf CLI)

# Frontend
cd frontend && npm install
npm run dev             # Dev server on :5173
npm run build           # Production build (tsc + vite)
npm test                # Run vitest (269 tests)

# Full stack
docker compose up --build
make test-e2e           # ATR browser tests
```

## Distribution

| Artifact | Registry | Install |
|----------|----------|---------|
| npm package | GitHub Packages | `npm install @imyousuf/collab-editor` |
| Docker images | GHCR | `docker pull ghcr.io/imyousuf/collab-editor/relay:dev` |
| Go module | GitHub | `go get github.com/imyousuf/collab-editor` |
| Proto stubs | Buf Schema Registry | `buf generate buf.build/imyousuf/collab-editor` |

CI publishes `:dev` / `@dev` on every push to main. Release tags publish versioned artifacts.

## Tech Stack

| Component | Technology |
|-----------|------------|
| WYSIWYG Editor | Tiptap v3 / ProseMirror |
| Source Editor | CodeMirror 6 |
| CRDT | Yjs + y-websocket + y-codemirror.next |
| Web Component | Lit 3 |
| React Wrapper | @lit/react |
| JSX/TSX Preview | Babel standalone + React 18 (iframe) |
| Relay Server | Go (coder/websocket, gRPC, chi, koanf, Prometheus) |
| Multi-instance | Redis pub/sub (go-redis) |
| Frontend Tests | Vitest (269 tests across 14 files) |
| Backend Tests | Go testing + miniredis |
| CI/CD | GitHub Actions (CI, npm publish, Docker publish, proto lint) |

## Documentation

- [Editor Architecture Research](docs/research/collaborative-editor-architecture.md)
- [HTTP Storage Provider SPI](docs/research/collab-editor-http-spi.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE).
