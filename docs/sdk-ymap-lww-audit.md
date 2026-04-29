# SDK Y.Map LWW Divergence Audit

## Executive Summary

**Risk level: low** for all three SDKs (Go, TypeScript, Python).

The Y.Map last-write-wins phantom-delete bug that drove the relay's Node-yjs sidecar pivot operates on the relay's wire path — specifically on SyncStep2 reply generation, which encodes the local Y.Doc's deleteSet to peers. The SDK side never generates SyncStep2 replies and never operates on Y.Map at all; it is a pure consumer that calls `apply_update` followed by `getText().toString()`. Cached Y.Doc accumulation across flushes is a real lifetime characteristic but is structurally harmless because the LWW bug requires Y.Map mutations to manifest.

One low-priority defensive recommendation for the Go SDK is noted below.

## Per-SDK Findings

### Go SDK (`pkg/spi/`)

**Y.Doc lifetime — cached, reused across flushes.**

`ProviderProcessor` holds an unbounded `cache map[string]YDocEngine` (`pkg/spi/processor.go:21`). `getOrCreateEngine` (`processor.go:40-49`) creates one `ygoEngine` per document ID on first flush and keeps it for the life of the processor. Each flush calls `engine.ApplyUpdate(yjsUpdate)` followed by `engine.GetText(textKey)` (`processor.go:54-88`). The wrapped `*crdt.Doc` (`ygo_engine.go:6-8`) accumulates state across all flushes for that document.

**Y.Map usage — none.**

`YDocEngine` exposes only `ApplyUpdate`, `GetText`, `InsertText`, `EncodeStateAsUpdate` (`ydoc_engine.go`). `ygoEngine.GetText` calls `e.doc.GetText(name).ToString()` — Y.Text only. The SDK never constructs or operates on a Y.Map. The relay's persistence buffer carries Y.Text mutations; there is no application-level Y.Map in the room doc.

**Text extraction path — direct Y.Text walk.**

`crdt.Doc.GetText(name).ToString()` walks the Y.Text item linked list and concatenates non-deleted string items. Structurally independent of Y.Map's deleteSet. Even if the cached Y.Doc accumulated phantom Y.Map deleteSet entries (it can't — no Y.Map exists), Y.Text resolution would not be influenced.

**Conclusion: no exposure.**

### TypeScript SDK (`packages/provider-sdk-ts/`)

**Y.Doc lifetime — cached, reused across flushes.**

`ProviderProcessor` holds a `DocCache` (`provider.ts:82-85`). `processStore` retrieves or creates a `Y.Doc` per document ID (`provider.ts:119-125`) and reuses it. `applyBase64Update` calls `Y.applyUpdate(doc, yjsUpdate)` (`engine.ts:34`).

**Y.Map usage — none.** `extractText` calls `doc.getText(TEXT_KEY).toString()` (`engine.ts:39-41`). Only Y.Doc.getText is used.

**Text extraction path — canonical `yjs` npm package.** No LWW divergence — the relay-wire bug was specific to ygo's Go port.

**Conclusion: no exposure.**

### Python SDK (`packages/provider-sdk-py/`)

**Y.Doc lifetime — cached, reused across flushes.**

`ProviderProcessor` holds a `DocCache` (`provider.py:141`). `process_store` retrieves or creates a `pycrdt.Doc` per document ID (`provider.py:168-172`).

**Y.Map usage — none.** `extract_text` calls `str(doc.get(TEXT_KEY, type=pycrdt.Text))` (`engine.py:67-68`). Only `pycrdt.Text` is used.

**Text extraction path — pycrdt (Rust y-crdt bindings).** Shares canonical-yjs semantics; no LWW divergence reported.

**Conclusion: no exposure.**

## Why the SDK Is Structurally Safe

For the phantom-delete corruption to matter in the SDK path, three conditions would have to hold simultaneously:

1. The SDK Y.Doc accumulates phantom deleteSet entries — **requires Y.Map.set replacement cycles**, which never happens because no Y.Map is used.
2. Those phantom entries influence text extraction — they don't, because `Y.Text.toString()` walks the Y.Text item chain independently of the document deleteSet.
3. The SDK generates a SyncStep2 reply delivering phantom deletes to a peer — **the SDK never generates SyncStep2**. It only calls `GetText` after applying updates.

The SDK is a pure consumer of updates: apply → read text → discard the text. It never acts as a sync peer.

## Recommendations

**One low-priority defensive improvement for the Go SDK:**

`pkg/spi/processor.go` has an unbounded `cache map[string]YDocEngine` with no eviction. The TS and Python SDKs already use an LRU `DocCache` (default `maxSize=1000`); the Go processor retains a `*crdt.Doc` for every document ID seen since process start. Not a correctness risk, but a memory leak in long-running providers handling many distinct documents.

Recommended: introduce an LRU around `ProviderProcessor.cache` analogous to the TS/Python `DocCache`. File: `pkg/spi/processor.go`, struct `ProviderProcessor`, field `cache`.

## Key References

- `pkg/spi/processor.go:21,40-49,54-88` — Go SDK cache and flush entrypoint
- `pkg/spi/ygo_engine.go:19` — `GetText` calls `Y.Text.ToString()` directly
- `pkg/spi/ydoc_engine.go` — interface confirms Y.Text-only operations
- `packages/provider-sdk-ts/src/engine.ts:29,39` — TS apply + extract
- `packages/provider-sdk-ts/src/provider.ts:82-85,119-125` — TS DocCache usage
- `packages/provider-sdk-py/collab_editor_provider/engine.py:62,67` — Python apply + extract
- `packages/provider-sdk-py/collab_editor_provider/cache.py` — Python LRU DocCache
- `packages/provider-sdk-py/collab_editor_provider/provider.py:141,168-172` — Python processor cache usage
