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

- **Web Component (`<multi-editor>`)** — A Lit-based custom element combining Tiptap v3/ProseMirror for WYSIWYG editing and CodeMirror 6 for source editing. Supports collaborative editing via Yjs with `Y.XmlFragment` as the canonical CRDT type.
- **Go WebSocket Relay** — A stateless relay server that upgrades HTTP connections to WebSocket, manages document rooms, and broadcasts Yjs binary updates between peers. Delegates all persistence to an external storage provider via HTTP.
- **Storage Provider (SPI)** — A pluggable HTTP API contract for document persistence. Implementors deploy their own service in any language, backed by any storage system (PostgreSQL, S3/GCS, etc.).

## Key Design Decisions

- **Y.XmlFragment is canonical**: The rich-text tree is the live CRDT, not raw Markdown text. This provides structure-aware conflict resolution where concurrent edits to different parts of the document merge cleanly.
- **Exclusive-view editing**: WYSIWYG and source views cannot be collaboratively edited simultaneously due to Yjs type incompatibility (`Y.XmlFragment` vs `Y.Text`). Content is serialized on view switch, following the pattern used by CKEditor 5, Outline, and others.
- **Decoration-based syntax highlighting**: Code blocks within rich text use lowlight/Shiki decorations rather than embedded CodeMirror instances, avoiding cursor bridging and remote cursor rendering issues. Full CodeMirror 6 is reserved for source-mode editing of the entire document.
- **Provider-agnostic persistence**: The relay is Yjs-aware but storage-unaware. Compaction (merging updates into snapshots) happens in the relay via Yrs FFI; the storage provider only stores and retrieves opaque blobs.

## Storage Provider SPI

The relay communicates with the storage provider via REST. Required endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/documents/{documentId}/load` | POST | Load document state for room bootstrap |
| `/documents/{documentId}/updates` | POST | Persist batched incremental updates |
| `/documents/{documentId}` | DELETE | Delete all document data |

Optional/recommended endpoints include compaction, versioning, health checks, and advisory locking. See [docs/research/collab-editor-http-spi.md](docs/research/collab-editor-http-spi.md) for the full SPI contract and OpenAPI spec.

## Web Component Usage

```html
<multi-editor
  mode="wysiwyg"
  format="markdown"
  language="html"
  placeholder="Start writing..."
  theme="light"
></multi-editor>

<script>
  const editor = document.querySelector('multi-editor');
  editor.collaboration = {
    enabled: true,
    roomName: 'doc-123',
    providerUrl: 'wss://collab.example.com',
    user: { name: 'Alice', color: '#e06c75' },
  };
</script>
```

## Documentation

- [Editor Architecture Research](docs/research/collaborative-editor-architecture.md) — Full analysis of editor selection, Markdown fidelity, view switching, code block embedding, and web component packaging.
- [HTTP Storage Provider SPI](docs/research/collab-editor-http-spi.md) — Complete API contract for pluggable storage backends, including Go client code, binary transport optimization, and async flush pipeline details.

## Tech Stack

| Component | Technology |
|-----------|------------|
| WYSIWYG Editor | Tiptap v3 / ProseMirror |
| Source Editor | CodeMirror 6 |
| CRDT | Yjs |
| Web Component | Lit |
| Relay Server | Go |
| CRDT Merge (FFI) | Yrs (Rust) |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
