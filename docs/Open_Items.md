# Open Items

Things to monitor, known limitations, and trade-offs that are acceptable today but may need revisiting.

## To Monitor

### 1. Replicator performance under high edit volume

After the `syncDoc` + `editorDoc` split (see `docs/research/` or the project plan), every local edit fires `update → replicator → applyUpdate` on the other doc. This doubles the update-event volume per keystroke.

- **Impact today**: negligible for typical collab-editor documents (a few hundred KB of text).
- **What to watch for**: large documents (> 1 MB of text, or thousands of concurrent authors over long sessions) may show noticeable CPU / GC pressure during active typing.
- **Mitigation if it becomes an issue**: batch replication with `requestIdleCallback` / microtask coalescing, or switch to delta replication (encode only the incoming update's diff rather than applying to the mirror doc directly).
- **How to measure**: profile with Chrome DevTools Performance panel during a stress test (two peers, 10k-line document, continuous typing). Look for `Y.applyUpdate` time in the replicator listeners.

### 2. Y.Text rebind on `editorDoc` reset

On suggest-mode submit/discard, we destroy `editorDoc` and recreate it from `syncDoc` state (Option 1). This requires editor bindings (Tiptap `TextBinding`, CodeMirror `yCollab`) to rebind to the new Y.Text. Historically rebind-on-hot-path caused bugs (markdown serializer drift, yCollab ViewPlugin capture, Compartment swap sequencing).

- **Impact today**: rebind now only fires on explicit suggest transitions (rare, user-initiated, both sides at a known-matching text state), not mid-typing.
- **What to watch for**: regressions where the editor surface content diverges from the new Y.Text after rebind, or "normalization" writes on the first keystroke after rebind.
- **Mitigation if issues appear**: initial sync after rebind must be strictly `yText → editor` (not echoing the editor's current content back). Unit + integration tests cover the symmetric-capture contract in `suggest-engine-integration.test.ts`.

## Known Limitations

### A. Accept via text-diff loses CRDT precision on concurrent overlapping accepts

When a reviewer accepts a suggestion, we apply the `{before_text, after_text}` diff to `syncText` via `applyStringDiff`, producing fresh CRDT ops on the reviewer's clientID. This avoids the dead-items pathology of replaying the suggester's `yjs_payload`, but:

- If two reviewers on different peers concurrently accept suggestions whose ranges overlap, the two independent text-diff applications may produce a surprising merged result vs. what a pure CRDT merge would have produced.
- **In practice**: no worse than any text editor handling concurrent edits on the same range. Yjs still resolves the resulting ops deterministically across peers — the output is just "reviewer-A's accept + reviewer-B's accept, both applied as fresh text edits" rather than "both suggestions' CRDT graphs merged".
- **Not fixing now** because (a) the scenario is rare (two reviewers accepting overlapping suggestions at the same moment), (b) the result is still a deterministic converged state across peers, and (c) the dead-items alternative has worse failure modes.
- **Revisit if**: user reports of "my accept got partially clobbered" come in. Possible future fix: accept a suggestion by applying the suggester's captured `yjs_payload` to `syncDoc` only when the suggester's items are still garbage-collectable (i.e., not already dead from a prior revert cycle).
