# Document Flow Architecture

A reference for the three-layer Y.Doc/Y.Text model used by the
`<multi-editor>` web component. Target reader: a Yjs-literate engineer
joining the project who needs to know what state lives where, what is
authoritative, and why we maintain two Y.Docs per editor instance.

> **Companion reading.** [`provider-sdk.md`](provider-sdk.md) covers
> the persistence side of the wire (relay → provider). This document
> covers the browser side (editor → relay).

---

## TL;DR

```
                    ┌────────────────────────────────────────────────┐
                    │   Y.Text — canonical CRDT (logical, not phys.) │
                    │   the merged state across every peer's syncDoc │
                    └────────────────────────────────────────────────┘
                                          │
                                          │ converges via y-websocket
                                          │
   PEER A                                 ▼                                PEER B
 ┌──────────────────────────────────────────────────────────────────┐
 │  syncDoc           ◄─── relay (stateless broadcast) ───►          │
 │  (the wire-bound Y.Doc; y-websocket / SocketIOProvider)           │
 └────────────▲──────────────────────────────────────────────┬──────┘
              │                                              │
       inbound│                                              │
       (open) │                       outbound (gated)       │
              │                                              ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │                       DocReplicator                              │
 │   inboundOpen  : syncDoc.update  → Y.applyUpdate(editorDoc, …)   │
 │   outboundOpen : editorDoc.update → Y.applyUpdate(syncDoc,  …)   │
 └────────────▲──────────────────────────────────────────────┬──────┘
              │                                              │
              │                                              │
 ┌──────────────────────────────────────────────────────────────────┐
 │  editorDoc                                                       │
 │  (bound to Tiptap via TextBinding, to CodeMirror via yCollab)    │
 └──────────────────────────────────────────────────────────────────┘
```

Three layers:

1. **Y.Text** — the canonical CRDT. Logical state, not a single object.
2. **`syncDoc`** — the per-client Y.Doc that talks to the wire.
3. **`editorDoc`** — the per-client Y.Doc the editor surfaces bind to,
   fronted by `DocReplicator` whose two gate flags decide which
   updates cross between `editorDoc` and `syncDoc`.

In normal mode the gates are open and the two Y.Docs are kept in
lockstep. In Suggest Mode the outbound gate closes: local keystrokes
stay on `editorDoc` while peer updates still flow inbound, so the
draft auto-rebases.

---

## The three layers

### 1. Y.Text — canonical CRDT

The top of the stack is logical, not physical. There is no single
`Y.Text` object that owns "the truth"; the truth is the merged state
across every peer's `syncDoc`, propagated by y-websocket. Each peer
sees its own copy in `syncDoc.getText('source')` and (mirrored)
`editorDoc.getText('source')`.

What everyone agrees on:

- The Y.Text type name is `'source'` across the codebase
  (`collab-provider.ts:44`, `collab-provider.ts:47`).
- Storage providers persist the **resolved plain-text content** of
  this Y.Text — never CRDT binary.
- All three editor bindings (Tiptap WYSIWYG, CodeMirror source,
  Markdown preview + source) bind to the same Y.Text on `editorDoc`.

CodeMirror binds via `y-codemirror.next` (yCollab), which hooks
directly into Y.Text. Tiptap binds via `TextBinding`
(`text-binding.ts`), which keeps Tiptap and Y.Text in sync via a
diff-based debounce — see [text-binding.ts:317](../frontend/src/collab/text-binding.ts)
for the `applyStringDiff` helper used to translate full-content
serializations into minimal Y.Text mutations.

### 2. `syncDoc` — the wire-bound Y.Doc

`syncDoc` is the Y.Doc that talks to the relay. It is the doc passed
to `WebsocketProvider` / `SocketIOProvider`
(`collab-provider.ts:65-78`). Every Yjs sync-protocol message —
`SYNC_STEP_1`, `SYNC_STEP_2`, update broadcasts — flows through
`syncDoc`.

- Constructed in `CollaborationProvider`'s constructor:
  `collab-provider.ts:43-48`.
- Exposed publicly as `collab.syncDoc` and `collab.syncText`.
- The shared `Y.Map` for metadata (`meta`) lives on `syncDoc` —
  collaborators-side metadata that everyone must see is canonical
  here, not on `editorDoc`.
- Awareness (cursor presence) is bound to `syncDoc`'s transport.
- Comment anchors (`Y.RelativePosition`) are encoded against
  `syncDoc` because that is the doc the comments engine binds to —
  see `multi-editor.ts:1569-1578`. This matters: if you encode an
  anchor against `editorDoc` and `editorDoc` is later destroyed by
  `resetEditorDoc()`, the relative position is dead.

`syncDoc` is also where the relay's pre-load / handshake state
arrives — the `whenSynced()` promise resolves when the relay has
replied with a real `SYNC_STEP_2` and the client has applied it
(`collab-provider.ts:156-167`).

### 3. `editorDoc` — the local, replaceable Y.Doc

`editorDoc` is what the editor surfaces actually bind to.

- Constructed alongside `syncDoc` in `CollaborationProvider`'s
  constructor: `collab-provider.ts:46-48`.
- Exposed as `collab.editorDoc` / `collab.editorText`.
- Tiptap's `TextBinding` observes `editorText` (via the binding's
  `_ytextObserver`); CodeMirror's yCollab plugin binds to `editorText`
  too (via the binding's editor instance).
- It is **mutable, not durable**: `resetEditorDoc()`
  (`collab-provider.ts:195-231`) destroys it whole and rebuilds a
  fresh one from `syncDoc`'s state. Bindings re-attach via the
  `onEditorDocReset` callback.

Why this layer exists at all: see "Why two Y.Docs?" below.

### The replicator

`DocReplicator` (`doc-replicator.ts`) is a thin bidirectional pipe
between `syncDoc` and `editorDoc`. It is the only thing connecting
the two — if you destroy the replicator, the docs drift apart.

- Two boolean gates: `inboundOpen` (sync → editor) and `outboundOpen`
  (editor → sync). Defaults: both open.
- Loop prevention via a private origin symbol
  (`doc-replicator.ts:35`): each replicated update is tagged, and the
  listener on the other side ignores updates that match its own tag.
  This is the textbook Yjs origin-tag pattern.
- `seedEditorFromSync()` (`doc-replicator.ts:90-94`) copies sync state
  into a fresh editor doc — used after `resetEditorDoc()`.

Critically, **the outbound gate is a hard filter, not a buffer**. Edits
made while it is closed are not replayed when it reopens
(`doc-replicator.test.ts:149-162`). This is intentional: the only safe
way to reopen after a closed-gate session is to discard the divergent
state on `editorDoc` (via `resetEditorDoc()`), not to reopen and hope.

#### Why two Y.Docs?

Yjs identifies operations by `(clientID, clock)` pairs. Once a Y.Doc
emits ops with its `clientID` that the wire has not seen, those ops
are causally referenced by every subsequent op from that doc. There
is no clean way to "take back" a window of local edits and then
continue editing on the same doc — peers either see the
appear-and-disappear sequence, or pending ops queue forever waiting
for a prefix that will never arrive
(`doc-replicator.test.ts:61-92`).

Suggest Mode needs exactly that capability: let the user type, then
either submit a textual diff (peers should never see the drafts) or
revert (peers should never see the drafts). The two-doc split solves
this by treating `editorDoc` as disposable. Suggest Mode closes the
outbound gate, the user types into `editorDoc`, and on submit/discard
we throw away the whole `editorDoc` and rebuild from `syncDoc`. Fresh
clientID, fresh clock, no clock-gap aftermath.

---

## Normal mode flow

Both gates open. The two docs stay in lockstep.

**Local keystroke (WYSIWYG, simplified):**

```
user keystroke
  → Tiptap fires 'update'
  → TextBinding debounces 100ms (text-binding.ts:97-100)
  → applyStringDiff writes minimal insert/delete to editorText (editorDoc)
  → editorDoc fires 'update'
  → DocReplicator._onEditorUpdate (outboundOpen=true)
  → Y.applyUpdate(syncDoc, update, replicator._origin)
  → syncDoc fires 'update'
  → y-websocket transport encodes & sends to relay
  → relay broadcasts to peers
```

**Local keystroke (CodeMirror source mode):**

CodeMirror uses `y-codemirror.next` (yCollab) which hooks Y.Text
directly. The path collapses:

```
user keystroke
  → yCollab writes to editorText (editorDoc)
  → DocReplicator mirrors editorDoc → syncDoc
  → y-websocket sends
```

While source mode is active the WYSIWYG `TextBinding` is paused
(`text-binding.ts:155-168`) so Tiptap doesn't echo CodeMirror's
writes back to Y.Text.

**Remote update:**

```
peer's update arrives over WebSocket
  → y-websocket calls Y.applyUpdate(syncDoc, …, this._provider)
  → syncDoc fires 'update' (origin = the WebsocketProvider)
  → DocReplicator._onSyncUpdate (inboundOpen=true)
  → Y.applyUpdate(editorDoc, update, replicator._origin)
  → editorDoc fires 'update' / Y.Text observers fire
  → TextBinding._ytextObserver schedules a microtask
  → _applyYTextToEditor() calls editor.commands.setContent(…)
  → user sees the remote edit
```

`CollaborationProvider` also fires its own
`onRemoteUpdate(callback)` when `syncDoc.update` originates from the
provider (`collab-provider.ts:109-113`). Coordinators (blame,
versioning) listen here.

---

## Suggest Mode flow

Suggest Mode is a Google-Docs-style "propose a change" feature. The
user enters Suggest Mode, edits freely, and submits a payload that
peers can review/accept/reject. Until the payload is accepted, peers
must not see the drafts.

The plumbing lives in two places:

- `SuggestEngine` (`suggest-engine.ts`) — owns the gate and the
  baseline text snapshot.
- `multi-editor.ts` `_handleSuggest*` and
  `_handleCommentSuggestion*` — drive the engine in response to
  toolbar / comment-panel events.

### Enable

`SuggestEngine.enable(currentText)` (`suggest-engine.ts:51-57`):

1. Store `_textAtEnable = currentText` (the baseline that submits will
   diff against).
2. `collab.replicator.outboundOpen = false` — outbound gate closes.

That is the entire enter step. There is no buffer Y.Doc, no
re-binding. The editor keeps writing to the same `editorText`; the
replicator just drops those updates on the floor instead of forwarding.

### While active

```
user keystroke
  → ... → editorDoc fires 'update'
  → DocReplicator._onEditorUpdate sees outboundOpen=false
  → "OUTBOUND BLOCKED" log entry, update is dropped
  → editorDoc diverges from syncDoc (peers do not see)

peer keystroke
  → relay broadcasts → syncDoc fires 'update' (origin = provider)
  → DocReplicator._onSyncUpdate sees inboundOpen=true
  → Y.applyUpdate(editorDoc, …) — peer change rebases onto the draft
  → editor reflects the rebased state
```

The auto-rebase is the whole reason inbound stays open. The user's
draft is "anchored" by `_textAtEnable`, but the document around them
keeps moving with peer activity, and they see it — they don't end up
proposing a diff against stale text.

The integration test `suggest-engine-routing.test.ts` exercises every
arm of this contract (lines 39-103).

### Submit

`SuggestEngine.commit(authorNote, currentText)`
(`suggest-engine.ts:133-138`):

1. **Build the payload**. `buildSuggestion` computes the smallest
   `[start, end)` range in `_textAtEnable` that encloses the change
   (`suggest-engine.ts:166-186`), then emits a
   `{anchor, view, author_note}` triple. `view.before_text` and
   `view.after_text` are the text-level slices; there is no
   `yjs_payload` in the new model.
2. **Reset `editorDoc`**. `collab.resetEditorDoc()` destroys the
   diverged `editorDoc`, builds a fresh one seeded from `syncDoc`,
   and fires `onEditorDocReset` so bindings re-attach.
3. **Reopen the gate**. `disable()` flips `outboundOpen` back to
   `true` and clears `_textAtEnable`.

After commit, `multi-editor` hands the payload to
`CommentEngine.commitSuggestion(payload)` to persist the proposal as
a thread on the comments SPI (`multi-editor.ts:1759-1760`).

> Why reset rather than reuse? Without a fresh `editorDoc`,
> subsequent local edits would carry clocks the wire has never seen
> a prefix for, and queue forever as pending structs. The
> doc-replicator test at lines 61-92 spells this out.

### Discard

`SuggestEngine.discard()` (`suggest-engine.ts:141-145`): same as
`commit()` minus the payload — reset `editorDoc`, reopen the gate,
clear `_textAtEnable`. After discard, `multi-editor` re-enables
Suggest Mode from the restored baseline so the user can keep
proposing (`multi-editor.ts:1739-1748`).

### Accept (reviewer side)

Accept is a frontend-only operation in the new model. There is no
`yjs_payload` round-trip; the reviewer applies a textual diff to
`syncText` and the y-websocket transport propagates the change like
any other peer edit.

`_handleCommentSuggestionAccept` (`multi-editor.ts:1796-1852`):

1. End any in-flight preview (`_endSuggestionPreview` resets
   `editorDoc` and reopens the gate so the accept op replicates
   cleanly back into the fresh editorDoc via the inbound listener).
2. Resolve the thread's anchor against the **current** `Y.Text`
   (anchors are `Y.RelativePosition`, so they survive concurrent
   edits).
3. `tryApplyTextSuggestion(syncText, anchor, after_text)` — apply
   the textual diff to `syncText`. The reviewer's `clientID` owns
   the resulting CRDT ops.
4. Legacy fallback: pre-split threads may carry a base64 Y.js
   update; if the text-level path can't apply (anchor lost), apply
   that update instead (`multi-editor.ts:1824-1830`).
5. Mark the thread `accepted` on the comments SPI.
6. **Re-baseline Suggest Mode** if it is still active. This is the
   bug we just fixed: applying the accept on `syncText` mirrors back
   into `editorText`, and `_textAtEnable` (captured pre-accept) would
   then mistakenly read the accepted text as a local draft. We `await
   Promise.resolve()` to drain Tiptap's microtask-deferred
   `ytext→editor` apply, then call
   `_suggestEngine.rebase(_binding.getCurrentSerialized())`
   (`multi-editor.ts:1843-1846`) so `hasPendingChanges()` and the
   "Exit Suggest Mode" prompt only flag genuine drafts.

`SuggestEngine.rebase(newBaseline)` (`suggest-engine.ts:94-97`)
exists exclusively for this re-baseline — it updates
`_textAtEnable` without touching the gate. The doc comment on the
method spells out the false-positive scenario it prevents.

### Reject / dismiss

Both routes (`_handleCommentSuggestionReject` line 1854,
`_handleCommentSuggestionDismiss` line 1868) just patch the thread's
status on the comments SPI. No Y.Doc mutation, no gate flip.
"Dismiss" is reserved for orphaned suggestions — anchor's
`quoted_text` no longer present in the document — and resolves to
`not_applicable`.

### Preview

When a reviewer hovers a thread, `multi-editor` previews the
suggestion's `after_text` on `editorText` only:
`_startSuggestionPreview` closes the outbound gate and applies the
diff directly to `editorText`
(`multi-editor.ts:1485-1497`). `_endSuggestionPreview` calls
`resetEditorDoc()` to throw away the preview and, if Suggest Mode
was active when the preview started, re-enters it from the restored
baseline.

---

## Where the canonical Y.Text "lives"

It is tempting to look at the diagram and ask which one is "the"
Y.Text. Pragmatic answer:

- **For peers:** the canonical state is the merged set of operations
  across every peer's `syncDoc`. `syncDoc` is the doc that
  participates in the y-websocket sync protocol, so for any given
  peer, `syncDoc` is the closest physical thing to "the truth". Read
  it when you want a snapshot consistent with what other peers see.

- **For the user staring at the screen:** what they are looking at
  is `editorText` on `editorDoc`. In normal mode this is byte-for-byte
  the same as `syncText`. In Suggest Mode it is `syncText + local
  drafts`.

- **For comment / version anchors:** encode against `syncDoc`. It
  outlives `editorDoc` (which is destroyed on every Suggest Mode
  exit, accept, and preview end).

- **For the storage provider:** the SPI is Yjs-agnostic. The
  provider sees `Load` / `Store` of plain text — see
  [provider-sdk.md](provider-sdk.md). The SDK extracts the resolved
  text from the canonical CRDT before calling `Store`.

---

## Common pitfalls

### The rebase-on-accept bug (fixed)

Symptom: user enters Suggest Mode, makes a draft, then accepts a
peer's suggestion. On Exit, the toolbar prompts "submit pending
suggestions?" even though the user has not edited anything since
accepting. Fix: `_suggestEngine.rebase(...)` after the accept's
text mutation has been mirrored into `editorText`. The microtask
drain (`await Promise.resolve()`) is load-bearing — without it,
Tiptap's deferred apply (`text-binding.ts:124-130`) hasn't run yet
and `getCurrentSerialized()` returns the pre-accept text, which
re-baselines to the wrong baseline. See `multi-editor.ts:1840-1847`.

### Orphan anchors

When the document around a comment / suggestion changes such that
the anchor's `quoted_text` is no longer present (typically: text
deleted by a peer, or overwritten by a later accept), the
`Y.RelativePosition` may still resolve but the substring it points
at is gone. Threads in this state stay visible in the comments
panel but show no inline decoration. The dismiss path
(`_handleCommentSuggestionDismiss`) marks them `not_applicable` so
they leave the pending list everywhere.

### Source vs WYSIWYG offset map

Y.Text stores raw Markdown / HTML source. ProseMirror (Tiptap)
parses that into a structured doc, and ProseMirror positions are
**not** the same as Y.Text offsets — the ProseMirror doc has no `#`,
no `**`, no `<p>`. The shared helper
`frontend/src/collab/pm-position-map.ts` maps Y.Text offsets to PM
positions via a substring walker; both `blame-tiptap-plugin` and
`comment-tiptap-plugin` use it. Do not reintroduce per-plugin
position maps — the duplication caused several decoration-drift
regressions in the past. CodeMirror source mode and plain-text
preview both fall through to identity mapping (offsets ARE
positions).

### Encoding anchors against `editorDoc`

Don't. `editorDoc` is destroyed on every `resetEditorDoc()` call
(Suggest Mode exit, accept, preview end). Encode `Y.RelativePosition`
against `syncDoc` — that's why `CommentEngine` binds to `syncDoc`
and resolution goes through `collab.syncDoc`
(`multi-editor.ts:1572`).

### Reopening the outbound gate without a reset

The outbound gate is a hard filter, not a buffer
(`doc-replicator.test.ts:149-162`). If you close the gate, generate
ops on `editorDoc`, and then just flip `outboundOpen = true`,
those ops are gone forever from the wire's perspective — but
`editorDoc`'s clock has already advanced, so the next local op
references a clientID/clock the wire has no prefix for. It will
queue as a pending struct on `syncDoc` and never apply. The only
sound exit from a closed-gate session is `resetEditorDoc()`, which
throws away the divergent doc entirely. `SuggestEngine.commit()` and
`SuggestEngine.discard()` both follow this rule;
`SuggestEngine.disable()` does not, which is why `disable()` is
documented as the "exit without revert" path and not the normal
way out.

---

## File map

| File | Role |
|------|------|
| [`collab-provider.ts`](../frontend/src/collab/collab-provider.ts) | Owns `syncDoc`, `editorDoc`, replicator; transport hookup; `resetEditorDoc()` |
| [`doc-replicator.ts`](../frontend/src/collab/doc-replicator.ts) | The two-gate bidirectional pipe |
| [`suggest-engine.ts`](../frontend/src/collab/suggest-engine.ts) | Suggest Mode controller (gate, baseline, rebase) |
| [`text-binding.ts`](../frontend/src/collab/text-binding.ts) | Tiptap ↔ Y.Text diff-based bridge; microtask-deferred ytext→editor |
| [`multi-editor.ts`](../frontend/src/multi-editor.ts) | Orchestrates Suggest submit / discard / accept / reject / preview |
| [`pm-position-map.ts`](../frontend/src/collab/pm-position-map.ts) | Y.Text offsets ↔ ProseMirror positions |
| [`__tests__/collab/doc-replicator.test.ts`](../frontend/src/__tests__/collab/doc-replicator.test.ts) | Locks down the gate + clock-continuity invariants |
| [`__tests__/collab/suggest-engine-routing.test.ts`](../frontend/src/__tests__/collab/suggest-engine-routing.test.ts) | End-to-end Suggest gate routing |
