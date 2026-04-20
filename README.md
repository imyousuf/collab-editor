# collab-editor

A collaborative WYSIWYG + source code editor built on Yjs CRDTs, packaged as a framework-agnostic web component.

## Architecture

```
┌──────────────┐          ┌──────────────────┐          ┌──────────────────┐
│  Browser     │  ws://   │  Go Relay         │  HTTP    │  Storage Provider│
│  <multi-     │─────────→│  (stateless,      │─────────→│  (any language,  │
│   editor />  │  Yjs     │   binary relay)   │  REST    │   any storage)   │
│              │  binary  │                   │          │                  │
└──────────────┘          └──────────────────┘          └──────────────────┘
```

The system has three main components:

- **Web Component (`<multi-editor>`)** — A Lit-based custom element with an interface-driven architecture. Combines Tiptap v3/ProseMirror for WYSIWYG editing, CodeMirror 6 for source editing, and iframe-based preview for JSX/TSX. All modes bind to the same `Y.Text` CRDT via yCollab (CodeMirror) and TextBinding (Tiptap). MIME-type registry maps content types to binding implementations.
- **Go WebSocket Relay** — A stateless broadcast relay that upgrades HTTP connections to WebSocket, manages document rooms, and forwards Yjs binary messages between peers. Does not maintain server-side Y.Docs. Delegates all persistence to an external storage provider via HTTP.
- **Storage Provider (SPI)** — A pluggable HTTP API contract for document persistence. Implementors deploy their own service in any language, backed by any storage system (PostgreSQL, S3/GCS, etc.).

## Key Design Decisions

- **Y.Text is canonical**: All editing modes (WYSIWYG, source, preview) bind to the same `Y.Text` instance. This simplifies the CRDT layer — concurrent edits from different modes merge cleanly via Yjs's text conflict resolution.
- **Dual-mount editing**: DualModeBinding keeps both Tiptap and CodeMirror mounted simultaneously, toggling visibility on mode switch. CodeMirror binds via yCollab; Tiptap binds via a custom TextBinding that uses diff-based (`applyStringDiff`) updates to preserve CRDT cursors and history.
- **Interface-driven bindings**: `IEditorBinding` implementations (DualModeBinding, SourceOnlyBinding, PreviewSourceBinding) are registered per MIME type via `EditorBindingFactory`. Each binding self-describes its supported modes.
- **Serialized initialization**: The Lit component's `_performInit` runs through a promise chain (`_initChain`) to prevent race conditions from Lit's async reactive lifecycle. Config snapshots detect staleness after async gaps.
- **Provider-agnostic persistence**: The relay is storage-unaware — it broadcasts Yjs binary messages between peers and delegates persistence to the storage provider via HTTP REST.

## Storage Provider SPI

The relay communicates with the storage provider via REST. Required endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/documents/load?path={documentId}` | POST | Load document state for room bootstrap |
| `/documents/updates?path={documentId}` | POST | Persist batched incremental updates |
| `/documents?path={documentId}` | DELETE | Delete all document data |

Optional/recommended endpoints include compaction, versioning, health checks, and advisory locking. See [docs/research/collab-editor-http-spi.md](docs/research/collab-editor-http-spi.md) for the full SPI contract and OpenAPI spec.

## Web Component Usage

```html
<multi-editor id="editor" placeholder="Start writing..." theme="light"></multi-editor>

<script type="module">
  const editor = document.getElementById('editor');

  // Configure all options at once — prevents multiple reinitialize cycles
  await editor.configure({
    mimeType: 'text/markdown',
    collaboration: {
      enabled: true,
      roomName: 'doc-123',
      providerUrl: 'wss://collab.example.com/ws',
      user: { name: 'Alice', color: '#e06c75' },
    },
    initialContent: '# Hello\n\nStart writing...',
  });

  // Switch between modes
  editor.switchMode('source');   // CodeMirror
  editor.switchMode('wysiwyg');  // Tiptap (markdown/html only)
  editor.switchMode('preview');  // iframe preview (jsx/tsx only)

  // Typed callback API
  editor.onContentChange(({ value, mode }) => console.log(value));
  editor.onCollabStatus(({ status }) => console.log(status));
</script>
```

### Supported MIME Types

| MIME Type | Modes | Binding |
|-----------|-------|---------|
| `text/markdown` | wysiwyg, source | DualModeBinding |
| `text/html` | wysiwyg, source | DualModeBinding |
| `text/jsx`, `text/tsx` | preview, source | PreviewSourceBinding |
| `text/javascript`, `text/typescript`, `text/x-python`, `text/css`, `application/json`, `text/yaml`, `text/plain` | source | SourceOnlyBinding |

## Documentation

- [Editor Architecture Research](docs/research/collaborative-editor-architecture.md) — Full analysis of editor selection, Markdown fidelity, view switching, code block embedding, and web component packaging.
- [HTTP Storage Provider SPI](docs/research/collab-editor-http-spi.md) — Complete API contract for pluggable storage backends, including Go client code, binary transport optimization, and async flush pipeline details.

## Tech Stack

| Component | Technology |
|-----------|------------|
| WYSIWYG Editor | Tiptap v3 / ProseMirror |
| Source Editor | CodeMirror 6 |
| CRDT | Yjs + y-websocket + y-codemirror.next |
| Web Component | Lit |
| JSX/TSX Preview | Babel standalone + React 18 (iframe) |
| Relay Server | Go (coder/websocket, chi, koanf) |
| Tests | Vitest (frontend, 84 tests), Go testing (backend) |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
