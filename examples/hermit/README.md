# Hermit

A local-only desktop file editor built with [Wails v2](https://wails.io)
and the `<multi-editor>` web component — no relay, no sidecar, no peers.
Demonstrates how to embed the editor in a desktop app and bridge the
browser surface to the host filesystem.

```
┌─────────────────────────────────────────────────┐
│ Wails window                                    │
│  ┌────────────────────────────────────────────┐ │
│  │ Menu (New / Open / Save / Save As)         │ │
│  ├────────────────────────────────────────────┤ │
│  │                                            │ │
│  │  <multi-editor> (Tiptap + CodeMirror)      │ │
│  │  collaboration = null                      │ │
│  │                                            │ │
│  └────────────────────────────────────────────┘ │
│         │ window.go.main.App.* (RPC bridge)     │
│         ▼                                       │
│  Go: os.ReadFile / os.WriteFile / dialogs       │
└─────────────────────────────────────────────────┘
```

The component is used in single-user mode — `collaboration` is left
unset, so no `CollaborationProvider` is constructed and the editor never
touches a relay or sidecar. Content flows through `getContent()` /
`setContent()` and the `editor-change` event.

## Prerequisites

- Go 1.22+
- Node.js 20+
- The [`wails` CLI](https://wails.io/docs/gettingstarted/installation):
  `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- Platform native deps:
  - **Linux**: `libgtk-3-dev` and `libwebkit2gtk-4.0-dev` (or
    `libwebkit2gtk-4.1-dev` on Ubuntu 24.04+ / Fedora 39+ — the
    Makefile auto-detects via `pkg-config` and passes the
    `webkit2_41` build tag).
  - **macOS**: Xcode Command Line Tools.
  - **Windows**: WebView2 runtime.
  - See the [Wails install docs](https://wails.io/docs/gettingstarted/installation) for the full list.
- The `frontend/` package in this repo must be built first so its `dist/`
  is present (the example links it via `file:../../../frontend`).

## Build & run

```bash
cd examples/hermit
make           # build the binary  → build/bin/hermit
make run       # build then launch
make dev       # hot-reload dev mode
make clean     # remove build artefacts
```

The `Makefile` builds the upstream `<multi-editor>` package first (so
its `dist/` is current), then invokes `wails build`. `make dev` starts a
Vite dev server for the example frontend and a Go runtime that proxies
file dialogs back to the JS side.

## Files

| Path | Purpose |
|------|---------|
| `wails.json`              | Wails project config |
| `main.go`                 | Window setup + asset embed |
| `app.go`                  | `OpenFile`/`SaveFile`/`SaveFileAs`/`LoadFile` exposed to JS |
| `frontend/index.html`     | Menu bar + `<multi-editor>` host page |
| `frontend/src/main.ts`    | Wires menu actions and shortcuts to `window.go.main.App` |
| `frontend/vite.config.ts` | Vite build that emits to `frontend/dist/` (embedded by Go) |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + N` | New |
| `Ctrl/Cmd + O` | Open |
| `Ctrl/Cmd + S` | Save |
| `Ctrl/Cmd + Shift + S` | Save As |
| `Ctrl/Cmd + W` | Close (unload current file) |

The window title shows `*` when there are unsaved changes. Closing the
window or opening a different file while dirty triggers a confirm prompt.

## MIME mapping

The editor's binding is selected from the file's MIME type (resolved in
`app.go::mimeForPath` from the extension):

| Extension | MIME | Binding |
|-----------|------|---------|
| `.md`, `.markdown` | `text/markdown` | DualMode (WYSIWYG ↔ source) |
| `.html`, `.htm`    | `text/html`     | DualMode |
| anything else      | `text/plain`    | SourceOnly |

## Why no collab?

Local-file editing doesn't need the relay/sidecar. Skipping it means:

- No Node child process to bundle.
- No WebSocket layer in the browser.
- No version history / blame / comments — those features are wired
  through the same `CollaborationProvider` that we're not constructing.

If you want any of those features, see `examples/basic/` for the
docker-compose stack (relay + sidecar + storage provider) and pass
`collaboration = { enabled: true, providerUrl, roomName, user }` to the
component instead.
