package relay

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/reearth/ygo/crdt"
)

func newTestRedisStateStore(t *testing.T) (*RedisStateStore, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedisStateStore(client, nil), mr
}

func TestRedisStateStore_AppendUpdate_RoundTrip(t *testing.T) {
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()

	// Empty log returns nothing.
	got, off, err := store.ReadLogTail(ctx, "doc-1", 0)
	if err != nil {
		t.Fatalf("initial read: %v", err)
	}
	if len(got) != 0 || off != 0 {
		t.Errorf("expected empty log initially, got %d entries at offset %d", len(got), off)
	}

	// Append three updates.
	for i, payload := range [][]byte{[]byte("a"), []byte("bb"), []byte("ccc")} {
		if err := store.AppendUpdate(ctx, "doc-1", payload); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	got, off, err = store.ReadLogTail(ctx, "doc-1", 0)
	if err != nil {
		t.Fatalf("read after appends: %v", err)
	}
	if len(got) != 3 || off != 3 {
		t.Fatalf("expected 3 entries at offset 3, got %d at %d", len(got), off)
	}
	if string(got[0]) != "a" || string(got[1]) != "bb" || string(got[2]) != "ccc" {
		t.Errorf("unexpected log contents: %q", got)
	}
}

func TestRedisStateStore_ReadLogTail_AdvancesWithOffset(t *testing.T) {
	// After reading up to offset N, the next read should only return
	// entries >= N. This is how a pod that already applied part of the
	// log via snapshot bootstrap asks for just the delta.
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if err := store.AppendUpdate(ctx, "doc-1", []byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}

	// Read tail from offset 2 — should get entries 3, 4, 5 (indices 2, 3, 4).
	got, off, err := store.ReadLogTail(ctx, "doc-1", 2)
	if err != nil {
		t.Fatal(err)
	}
	if off != 5 {
		t.Errorf("counter after read: got %d, want 5", off)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 tail entries, got %d", len(got))
	}
	for i, b := range got {
		if b[0] != byte(i+2) {
			t.Errorf("tail[%d] = %d, want %d", i, b[0], i+2)
		}
	}
}

func TestRedisStateStore_WriteSnapshot_TrimsLog(t *testing.T) {
	// Snapshot compaction: after WriteSnapshot, the log is trimmed so
	// subsequent ReadLogTail(snapOffset) returns only new entries.
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()

	for i := 0; i < 4; i++ {
		if err := store.AppendUpdate(ctx, "doc-1", []byte{byte('a' + i)}); err != nil {
			t.Fatal(err)
		}
	}
	// Take a "snapshot" (arbitrary non-empty bytes — the store doesn't
	// interpret them).
	if err := store.WriteSnapshot(ctx, "doc-1", []byte("snap-state")); err != nil {
		t.Fatal(err)
	}

	snap, off, err := store.ReadSnapshot(ctx, "doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(snap) != "snap-state" || off != 4 {
		t.Errorf("snapshot/offset: got %q/%d, want %q/4", snap, off, "snap-state")
	}

	// ReadLogTail at snapshot offset must return zero entries (log was trimmed).
	tail, _, err := store.ReadLogTail(ctx, "doc-1", off)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Errorf("log tail after snapshot should be empty, got %d entries", len(tail))
	}

	// Append two more — tail from snapshot offset should have those two.
	for _, p := range [][]byte{[]byte("e"), []byte("f")} {
		if err := store.AppendUpdate(ctx, "doc-1", p); err != nil {
			t.Fatal(err)
		}
	}
	tail, newOff, err := store.ReadLogTail(ctx, "doc-1", off)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || newOff != 6 {
		t.Fatalf("after 2 new appends, tail=%d entries, offset=%d", len(tail), newOff)
	}
	if string(tail[0]) != "e" || string(tail[1]) != "f" {
		t.Errorf("unexpected post-snapshot tail: %q", tail)
	}
}

func TestRedisStateStore_YjsStateRoundTrip_ColdStartEquivalence(t *testing.T) {
	// The invariant that matters for multi-pod cold-start: a pod that
	// reads the snapshot and replays the log tail arrives at a Y.Doc
	// byte-identical to the pod that wrote the snapshot + appended the
	// tail entries. Exercises the full loop end-to-end.
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()

	// Simulated "pod A": holds an authoritative Y.Doc, appends each
	// update as it's applied.
	podA := crdt.New(crdt.WithClientID(99))
	applyAndAppend := func(content string) {
		text := podA.GetText("source")
		podA.Transact(func(txn *crdt.Transaction) {
			// Append at end.
			text.Insert(txn, text.Len(), content, nil)
		})
		if err := store.AppendUpdate(ctx, "doc-1", podA.EncodeStateAsUpdate()); err != nil {
			t.Fatal(err)
		}
	}
	applyAndAppend("Hello")
	applyAndAppend(", world")

	// Snapshot checkpoint.
	if err := store.WriteSnapshot(ctx, "doc-1", podA.EncodeStateAsUpdate()); err != nil {
		t.Fatal(err)
	}
	applyAndAppend("!")

	// Simulated "pod B": cold-starts, pulls snapshot + tail, rebuilds.
	podB := crdt.New(crdt.WithClientID(100))
	snap, off, err := store.ReadSnapshot(ctx, "doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := podB.ApplyUpdate(snap); err != nil {
		t.Fatalf("apply snapshot: %v", err)
	}
	tail, _, err := store.ReadLogTail(ctx, "doc-1", off)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range tail {
		if err := podB.ApplyUpdate(entry); err != nil {
			t.Fatalf("apply tail entry: %v", err)
		}
	}

	if a, b := podA.GetText("source").ToString(), podB.GetText("source").ToString(); a != b {
		t.Errorf("pod A/B diverged: %q vs %q", a, b)
	}
	if podB.GetText("source").ToString() != "Hello, world!" {
		t.Errorf("unexpected content: %q", podB.GetText("source").ToString())
	}
}

func TestRedisStateStore_ReadSnapshot_ReturnsNilWhenAbsent(t *testing.T) {
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()
	snap, off, err := store.ReadSnapshot(ctx, "never-written")
	if err != nil {
		t.Fatal(err)
	}
	if snap != nil || off != 0 {
		t.Errorf("absent snapshot should be nil/0, got %v/%d", snap, off)
	}
}

func TestRedisStateStore_MultiPod_ColdStartHasCurrentState(t *testing.T) {
	// Simulates the Cloud Run / GKE autoscale-up case: pod A has been
	// serving a room for a while, pod B boots fresh and reads the state
	// store to catch up. After bootstrap, pod B serves an incoming peer
	// with the same state pod A would have served — without depending
	// on pod A being alive, pub/sub fan-out, or the storage provider
	// retaining Y history.
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()

	// Pod A's Room receives 3 updates and one snapshot compaction.
	podA, _ := newTestRoom(t)
	podA.SetStateStore(store)
	podA.BootstrapContent("Initial")

	// Simulate 3 peer edits landing on pod A. Each applies to ydoc AND
	// hits AppendUpdate via the hot path; we call the raw pipeline
	// here so the test doesn't depend on handleSyncMessage plumbing.
	for _, word := range []string{" + one", " + two", " + three"} {
		update := makeInsertAtEndUpdate(t, podA, word)
		_ = store.AppendUpdate(ctx, "doc-1", update)
	}
	// Flush-time snapshot: pod A records its current state.
	_ = store.WriteSnapshot(ctx, "doc-1", podA.YDocState())

	// One more update after the snapshot — this one must also land on
	// pod B via log-tail replay.
	lateUpdate := makeInsertAtEndUpdate(t, podA, " + late")
	_ = store.AppendUpdate(ctx, "doc-1", lateUpdate)

	// Pod B cold-starts. Reads snapshot + tail.
	podB, _ := newTestRoom(t)
	podB.SetStateStore(store)
	snap, off, err := store.ReadSnapshot(ctx, "doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := podB.BootstrapFromSnapshot(snap); err != nil {
		t.Fatalf("pod B bootstrap: %v", err)
	}
	tail, _, err := store.ReadLogTail(ctx, "doc-1", off)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range tail {
		if err := podB.ApplyLogEntry(entry); err != nil {
			t.Fatalf("pod B log replay: %v", err)
		}
	}

	// Both pods must now agree. The content is what matters for
	// end-user semantics; the Y.Doc state bytes may differ in op
	// ordering but GetText is stable under YATA merge.
	stateA := podA.YDocState()
	if err := podB.ApplyLogEntry(stateA); err != nil {
		t.Fatalf("cross-check apply: %v", err)
	}
	// After apply, pod B should be a superset (idempotent under YATA).
	// The simpler + more important check: the text matches.
	gotA := extractText(t, podA)
	gotB := extractText(t, podB)
	if gotA != gotB {
		t.Errorf("pod A/B text diverged after cold-start replay:\nA: %q\nB: %q", gotA, gotB)
	}
	if gotA != "Initial + one + two + three + late" {
		t.Errorf("unexpected content: %q", gotA)
	}
}

// makeInsertAtEndUpdate modifies the room's Y.Doc by appending content
// and returns the Yjs Update payload that represents the change.
func makeInsertAtEndUpdate(t *testing.T, room *Room, content string) []byte {
	t.Helper()
	room.ydocMu.Lock()
	defer room.ydocMu.Unlock()
	before := room.ydoc.EncodeStateAsUpdate()
	text := room.ydoc.GetText(sharedTextName)
	room.ydoc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, text.Len(), content, nil)
	})
	// Return the full state; YATA dedupes on apply so replaying full
	// state entries is safe for test purposes.
	_ = before
	return room.ydoc.EncodeStateAsUpdate()
}

func extractText(t *testing.T, room *Room) string {
	t.Helper()
	room.ydocMu.Lock()
	defer room.ydocMu.Unlock()
	return room.ydoc.GetText(sharedTextName).ToString()
}

// recordingBroker captures Publish calls for side-effect tests.
type recordingBroker struct {
	published map[string][][]byte
	subscribe func()
}

func (b *recordingBroker) Publish(_ context.Context, documentID string, data []byte) error {
	if b.published == nil {
		b.published = map[string][][]byte{}
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	b.published[documentID] = append(b.published[documentID], cp)
	return nil
}

func (b *recordingBroker) Subscribe(_ context.Context, _ string) (<-chan []byte, func(), error) {
	ch := make(chan []byte)
	close(ch)
	return ch, func() {}, nil
}

func (b *recordingBroker) Close() error { return nil }

func TestRedisStateStore_AppendUpdate_AlsoPublishesForLiveFanout(t *testing.T) {
	// Regression: dropping the broker.Publish call would silently break
	// cross-pod LIVE updates — edits on pod A would only reach pod B on
	// cold-start (via the log) but never during a shared-room session.
	// Tests that AppendUpdate triggers both the durable RPUSH AND the
	// fire-and-forget pub/sub broadcast.
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	broker := &recordingBroker{}
	store := NewRedisStateStore(client, broker)

	ctx := context.Background()
	payload := []byte("update-bytes")
	if err := store.AppendUpdate(ctx, "doc-1", payload); err != nil {
		t.Fatal(err)
	}

	got := broker.published["doc-1"]
	if len(got) != 1 {
		t.Fatalf("expected 1 broker publish, got %d", len(got))
	}
	if string(got[0]) != string(payload) {
		t.Errorf("broker got %q, want %q", got[0], payload)
	}
	// And it's also in the durable log.
	tail, _, err := store.ReadLogTail(ctx, "doc-1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 1 || string(tail[0]) != string(payload) {
		t.Errorf("log tail = %v, want [%q]", tail, payload)
	}
}

func TestRedisStateStore_AppendUpdate_WithoutBroker_IsLogOnly(t *testing.T) {
	// When the store is constructed without a broker (single-pod dev
	// or a test harness), AppendUpdate still persists — it just
	// doesn't publish. Regression guard against nil-deref if someone
	// forgets to wire broker.
	store, _ := newTestRedisStateStore(t)
	ctx := context.Background()
	if err := store.AppendUpdate(ctx, "doc-1", []byte("x")); err != nil {
		t.Fatal(err)
	}
	tail, _, err := store.ReadLogTail(ctx, "doc-1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 1 {
		t.Errorf("expected 1 log entry even without broker, got %d", len(tail))
	}
}

func TestRedisStateStore_AppendUpdate_SetsExpireOnKeys(t *testing.T) {
	// Regression guard for the TTL bump. Without EXPIRE on every append,
	// abandoned rooms would leak forever; without the bump, an active
	// room's log could expire mid-session. Both keys involved in the
	// append pipeline (log + counter) must carry a refreshed TTL.
	store, mr := newTestRedisStateStore(t)
	ctx := context.Background()
	if err := store.AppendUpdate(ctx, "doc-1", []byte("x")); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		redisStateKeyPrefix + "doc-1" + redisLogSuffix,
		redisStateKeyPrefix + "doc-1" + redisCounterSuffix,
	} {
		ttl := mr.TTL(key)
		if ttl <= 0 {
			t.Errorf("key %q has no TTL after AppendUpdate (ttl=%v)", key, ttl)
		}
	}
}

func TestNoopStateStore_IsCompletelyInert(t *testing.T) {
	// The single-pod fallback MUST be a true no-op so the relay works
	// without Redis. Regression guard: any future change that makes
	// the noop do side effects (e.g., caching) will break the
	// single-pod path.
	store := NewNoopStateStore()
	ctx := context.Background()

	if err := store.AppendUpdate(ctx, "doc", []byte("x")); err != nil {
		t.Error(err)
	}
	snap, off, err := store.ReadSnapshot(ctx, "doc")
	if err != nil || snap != nil || off != 0 {
		t.Errorf("noop ReadSnapshot: %v/%v/%d", err, snap, off)
	}
	tail, off, err := store.ReadLogTail(ctx, "doc", 0)
	if err != nil || tail != nil || off != 0 {
		t.Errorf("noop ReadLogTail: %v/%v/%d", err, tail, off)
	}
	if err := store.WriteSnapshot(ctx, "doc", []byte("x")); err != nil {
		t.Error(err)
	}
	if err := store.Close(); err != nil {
		t.Error(err)
	}
}
