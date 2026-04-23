package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	stdsync "sync"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

// ydocPeer wraps a Yjs *crdt.Doc for use as a fake client in room tests.
// Exposes just the sync-protocol operations the tests need.
type ydocPeer struct {
	doc *crdt.Doc
}

func newYDocPeerForTest(t *testing.T) *ydocPeer {
	t.Helper()
	return &ydocPeer{doc: crdt.New()}
}

func (p *ydocPeer) Text() string {
	return p.doc.GetText(sharedTextName).ToString()
}

func (p *ydocPeer) InsertText(s string) {
	txt := p.doc.GetText(sharedTextName)
	p.doc.Transact(func(txn *crdt.Transaction) {
		txt.Insert(txn, 0, s, nil)
	})
}

func (p *ydocPeer) EncodeSyncStep1() []byte {
	return ysync.EncodeSyncStep1(p.doc)
}

// EncodeUpdate returns a sync-message-framed Update carrying the full state
// of this peer's Y.Doc. In production, clients send incremental updates as
// they edit; for tests, sending the full state is a valid Update frame too.
func (p *ydocPeer) EncodeUpdate() []byte {
	return ysync.EncodeUpdate(p.doc.EncodeStateAsUpdate())
}

func (p *ydocPeer) ApplyUpdate(update []byte) error {
	return p.doc.ApplyUpdate(update)
}

func (p *ydocPeer) ApplySyncMessage(msg []byte) error {
	_, err := ysync.ApplySyncMessage(p.doc, msg, nil)
	return err
}

// mockConn implements the Conn interface for testing.
type mockConn struct {
	readCh  chan []byte
	writeCh chan []byte
	closed  bool
}

func newMockConn() *mockConn {
	return &mockConn{
		readCh:  make(chan []byte, 256),
		writeCh: make(chan []byte, 256),
	}
}

func (c *mockConn) ReadMessage(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case data := <-c.readCh:
		return data, nil
	}
}

func (c *mockConn) WriteMessage(ctx context.Context, data []byte) error {
	c.writeCh <- data
	return nil
}

func (c *mockConn) Close(code int, reason string) error {
	c.closed = true
	return nil
}

func newTestRoom(t *testing.T) (*Room, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			json.NewEncoder(w).Encode(spi.HealthResponse{Status: "ok"})
			return
		}
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(spi.StoreResponse{Stored: 1})
	}))
	t.Cleanup(srv.Close)

	client := provider.NewClient(provider.ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	metrics := NewMetrics()
	breaker := NewCircuitBreaker(client, 3, 10*time.Second, metrics)
	flusher := NewFlusher(client, breaker, metrics, 3, 100*time.Millisecond)
	cfg := RoomConfig{
		FlushDebounce:   50 * time.Millisecond,
		FlushMaxBytes:   65536,
		IdleTimeout:     1 * time.Second,
		MaxPeersPerRoom: 50,
	}
	room := NewRoom("test-doc", cfg, flusher, metrics)
	return room, srv
}

func TestRoom_AddRemovePeer(t *testing.T) {
	room, _ := newTestRoom(t)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	if room.PeerCount() != 1 {
		t.Errorf("peer count: got %d, want 1", room.PeerCount())
	}

	empty := room.RemovePeer(peer)
	if !empty {
		t.Error("expected room to be empty after removing last peer")
	}
	if room.PeerCount() != 0 {
		t.Errorf("peer count: got %d, want 0", room.PeerCount())
	}
}

func TestRoom_Broadcast(t *testing.T) {
	room, _ := newTestRoom(t)

	conn1 := newMockConn()
	conn2 := newMockConn()
	conn3 := newMockConn()
	peer1 := newPeer(conn1, room)
	peer2 := newPeer(conn2, room)
	peer3 := newPeer(conn3, room)

	room.AddPeer(peer1)
	room.AddPeer(peer2)
	room.AddPeer(peer3)

	// Broadcast from peer1 should go to peer2 and peer3 but not peer1
	room.Broadcast(peer1, []byte("hello"))

	// Check peer2 got it
	select {
	case msg := <-peer2.writeCh:
		if string(msg) != "hello" {
			t.Errorf("peer2 got %q", msg)
		}
	default:
		t.Error("peer2 didn't receive message")
	}

	// Check peer3 got it
	select {
	case msg := <-peer3.writeCh:
		if string(msg) != "hello" {
			t.Errorf("peer3 got %q", msg)
		}
	default:
		t.Error("peer3 didn't receive message")
	}

	// peer1 should NOT have received it
	select {
	case <-peer1.writeCh:
		t.Error("sender should not receive own broadcast")
	default:
		// good
	}
}

func TestRoom_HandleMessage_RelaysAllTypes(t *testing.T) {
	room, _ := newTestRoom(t)

	conn1 := newMockConn()
	conn2 := newMockConn()
	peer1 := newPeer(conn1, room)
	peer2 := newPeer(conn2, room)
	room.AddPeer(peer1)
	room.AddPeer(peer2)

	// Sync Update message relayed to peer2. We construct a real Yjs
	// update rather than hand-rolled bytes because Room.handleSyncMessage
	// now validates the sync frame through ygo and drops malformed ones.
	client := newYDocPeerForTest(t)
	client.InsertText("hi")
	msg := append([]byte{msgTypeSync}, client.EncodeUpdate()...)
	room.handleMessage(peer1, msg)

	select {
	case got := <-peer2.writeCh:
		if string(got) != string(msg) {
			t.Errorf("peer2 got %v, want %v", got, msg)
		}
	default:
		t.Error("peer2 should receive relayed message")
	}

	// Awareness message also relayed (pass-through — no Yjs validation).
	awareness := []byte{msgTypeAwareness, 0x01, 0x02}
	room.handleMessage(peer1, awareness)

	select {
	case got := <-peer2.writeCh:
		if string(got) != string(awareness) {
			t.Errorf("peer2 got %v, want %v", got, awareness)
		}
	default:
		t.Error("peer2 should receive awareness message")
	}
}

func TestRoom_Close(t *testing.T) {
	room, _ := newTestRoom(t)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	room.Close()

	// After close, peer count should still reflect the peer (not removed by Close)
	// but the closeCh should be closed
	select {
	case <-room.closeCh:
		// expected — channel is closed
	default:
		t.Error("closeCh should be closed after Close()")
	}
}

func TestRoom_HandleMessage_BuffersSyncUpdateMessages(t *testing.T) {
	// The flush pipeline only cares about Update frames (msg type 2);
	// SyncStep1/2 and awareness must not reach the persistence buffer.
	// With the Phase-1 rewrite, "validness" is enforced by ygo parsing —
	// fabricated byte strings no longer pass. Build real frames instead.
	room, _ := newTestRoom(t)
	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)

	a := newYDocPeerForTest(t)
	a.InsertText("a")
	updateA := append([]byte{msgTypeSync}, a.EncodeUpdate()...)
	room.handleMessage(peer, updateA)
	if room.buffer.Len() != 1 {
		t.Errorf("buffer.Len() = %d, want 1 after Update", room.buffer.Len())
	}

	// SyncStep1 triggers a SyncStep2 reply but MUST NOT buffer — it's a
	// session-specific handshake, not document content.
	step1 := append([]byte{msgTypeSync}, newYDocPeerForTest(t).EncodeSyncStep1()...)
	room.handleMessage(peer, step1)
	if room.buffer.Len() != 1 {
		t.Errorf("buffer.Len() = %d, want 1 (SyncStep1 must not buffer)", room.buffer.Len())
	}
	// drain the SyncStep2 reply so subsequent tests don't see it.
	select {
	case <-conn.writeCh:
	case <-time.After(time.Second):
	}

	// Awareness: broadcast path, not buffered.
	awareness := []byte{msgTypeAwareness, 0x01, 0x02}
	room.handleMessage(peer, awareness)
	if room.buffer.Len() != 1 {
		t.Errorf("buffer.Len() = %d, want 1 (awareness must not buffer)", room.buffer.Len())
	}

	// Another Update — buffer grows.
	b := newYDocPeerForTest(t)
	b.InsertText("bb")
	updateB := append([]byte{msgTypeSync}, b.EncodeUpdate()...)
	room.handleMessage(peer, updateB)
	if room.buffer.Len() != 2 {
		t.Errorf("buffer.Len() = %d, want 2 after second Update", room.buffer.Len())
	}
}

func TestRoom_HandleMessage_EmptyMessageNotBuffered(t *testing.T) {
	room, _ := newTestRoom(t)
	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	room.handleMessage(peer, []byte{})
	if room.buffer.Len() != 0 {
		t.Errorf("empty message should not be buffered, got buffer.Len() = %d", room.buffer.Len())
	}
}

func TestRoom_HandleMessage_SignalsFlushOnSizeThreshold(t *testing.T) {
	room, _ := newTestRoom(t)
	room.config.FlushMaxBytes = 10 // very low threshold

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// A real Yjs Update that carries enough content to exceed 10 bytes.
	client := newYDocPeerForTest(t)
	client.InsertText("hello world, this is padding")
	frame := append([]byte{msgTypeSync}, client.EncodeUpdate()...)
	room.handleMessage(peer, frame)

	// flushCh should be signaled
	select {
	case <-room.flushCh:
		// expected
	default:
		t.Error("flushCh should be signaled when buffer exceeds FlushMaxBytes")
	}
}

func TestRoom_FlushLoop_FlushesOnTimer(t *testing.T) {
	room, _ := newTestRoom(t)
	room.config.FlushDebounce = 50 * time.Millisecond

	// Add a sync message to buffer
	room.buffer.Append([]byte{0x00, 0x02, 0x01}, 0)

	done := make(chan struct{})
	go func() {
		room.StartFlushLoop(5 * time.Second)
		close(done)
	}()

	// Wait for flush to drain the buffer
	time.Sleep(150 * time.Millisecond)

	if room.buffer.Len() != 0 {
		t.Errorf("buffer should be drained by flush loop, got Len() = %d", room.buffer.Len())
	}

	room.Close()
	<-done
}

func TestRoom_FlushLoop_FinalFlushOnClose(t *testing.T) {
	room, _ := newTestRoom(t)
	room.config.FlushDebounce = 10 * time.Second // long enough that timer won't fire

	// Add messages to buffer
	room.buffer.Append([]byte{0x00, 0x02, 0x01}, 0)
	room.buffer.Append([]byte{0x00, 0x02, 0x02}, 0)

	done := make(chan struct{})
	go func() {
		room.StartFlushLoop(5 * time.Second)
		close(done)
	}()

	// Close the room — should trigger final flush
	room.Close()
	<-done

	if room.buffer.Len() != 0 {
		t.Errorf("buffer should be drained on close, got Len() = %d", room.buffer.Len())
	}
}

func TestRoom_FlushLoop_IndependentOfConnectionContext(t *testing.T) {
	room, _ := newTestRoom(t)
	room.config.FlushDebounce = 50 * time.Millisecond

	done := make(chan struct{})
	go func() {
		room.StartFlushLoop(5 * time.Second)
		close(done)
	}()

	// Simulate: first peer sends a message then disconnects
	room.buffer.Append([]byte{0x00, 0x02, 0x01}, 0)
	time.Sleep(100 * time.Millisecond)

	// Buffer should have been flushed by the ticker
	if room.buffer.Len() != 0 {
		t.Errorf("first batch should have flushed, got Len() = %d", room.buffer.Len())
	}

	// Simulate: second peer connects later and sends new messages.
	// The flush loop must still be alive to flush these.
	room.buffer.Append([]byte{0x00, 0x02, 0x02}, 0)
	time.Sleep(100 * time.Millisecond)

	if room.buffer.Len() != 0 {
		t.Errorf("second batch should have flushed, got Len() = %d", room.buffer.Len())
	}

	room.Close()
	<-done
}

// --- Sync protocol tests (Phase 1: server-side Y.Doc) ---

func TestRoom_BootstrapContent_SeedsYDoc(t *testing.T) {
	room, _ := newTestRoom(t)
	room.BootstrapContent("Hello, world!")
	state := room.YDocState()
	if len(state) == 0 {
		t.Fatal("YDocState empty after BootstrapContent")
	}
	// Verify the state decodes to the seeded content. We round-trip via a
	// fresh client-side Y.Doc to avoid reaching into room internals.
	peer := newYDocPeerForTest(t)
	if err := peer.ApplyUpdate(state); err != nil {
		t.Fatalf("client failed to apply server state: %v", err)
	}
	if got := peer.Text(); got != "Hello, world!" {
		t.Errorf("client text: got %q, want %q", got, "Hello, world!")
	}
}

func TestRoom_BootstrapContent_IsIdempotent(t *testing.T) {
	// Two relay instances cold-starting the same content must converge to
	// the SAME Y.Doc state — identical bytes. This is the regression guard
	// for the prior seeding-race doubling bug: pinning serverClientID=1
	// ensures both instances' seed updates carry the same (client, clock)
	// pair, so YATA dedupes them across the broker.
	contents := "Welcome\nBody\n"

	roomA, _ := newTestRoom(t)
	roomA.BootstrapContent(contents)
	roomA.BootstrapContent(contents) // second call — should not double-seed
	stateA := roomA.YDocState()

	roomB, _ := newTestRoom(t)
	roomB.BootstrapContent(contents)
	stateB := roomB.YDocState()

	if string(stateA) != string(stateB) {
		t.Errorf("seed updates diverged between instances: roomA=%d bytes, roomB=%d bytes", len(stateA), len(stateB))
	}
}

func TestRoom_SyncStep1_ReturnsSyncStep2WithServerState(t *testing.T) {
	// Regression: prior relay broadcast everything without responding,
	// so y-websocket's `synced` flag stayed false. The client compensated
	// with timing-based guards that masked content-doubling bugs. Now the
	// server is a proper Yjs peer and answers SyncStep1 with its state.
	room, _ := newTestRoom(t)
	room.BootstrapContent("Hello")

	client := newYDocPeerForTest(t)
	step1 := client.EncodeSyncStep1()
	framed := append([]byte{msgTypeSync}, step1...)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)

	room.handleMessage(peer, framed)

	select {
	case got := <-conn.writeCh:
		if len(got) < 1 || got[0] != msgTypeSync {
			t.Fatalf("expected sync envelope, got % x", got)
		}
		if err := client.ApplySyncMessage(got[1:]); err != nil {
			t.Fatalf("client failed to apply reply: %v", err)
		}
		if text := client.Text(); text != "Hello" {
			t.Errorf("after step2, client text: got %q, want %q", text, "Hello")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for SyncStep2")
	}
}

func TestRoom_Update_BroadcastsAndBuffers(t *testing.T) {
	// An Update message from peer A must:
	//   - Apply to the room's Y.Doc.
	//   - Broadcast to peer B (but not echo back to A).
	//   - Be buffered for the flush-to-provider path.
	// SyncStep1/2 frames must NOT be broadcast (session-specific).
	room, _ := newTestRoom(t)

	connA := newMockConn()
	peerA := newPeer(connA, room)
	room.AddPeer(peerA)

	connB := newMockConn()
	peerB := newPeer(connB, room)
	room.AddPeer(peerB)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peerA.writeLoop(ctx)
	go peerB.writeLoop(ctx)

	// Peer A produces an Update by editing its own Y.Doc and encoding.
	client := newYDocPeerForTest(t)
	client.InsertText("Hi")
	update := client.EncodeUpdate() // a Yjs Update (msg type 2) framed by ygo/sync

	frame := append([]byte{msgTypeSync}, update...)
	room.handleMessage(peerA, frame)

	// Peer B receives a copy of the frame.
	select {
	case got := <-connB.writeCh:
		if string(got) != string(frame) {
			t.Errorf("peer B received different bytes: got % x, want % x", got, frame)
		}
	case <-time.After(time.Second):
		t.Fatal("peer B did not receive the update")
	}

	// Peer A must NOT receive its own frame echoed back.
	select {
	case got := <-connA.writeCh:
		t.Errorf("peer A received its own echo: % x", got)
	case <-time.After(50 * time.Millisecond):
		// expected
	}

	// Update is buffered for persistence.
	if room.buffer.Len() == 0 {
		t.Error("update was not buffered for persistence")
	}

	// Room's Y.Doc applied the update.
	if room.YDocState() == nil {
		t.Error("room YDocState returned nil after update")
	}
}

func TestRoom_BootstrapFromSnapshot_RebuildsState(t *testing.T) {
	// Phase-2 cold-start: a fresh pod reads a snapshot from the
	// StateStore and rebuilds a byte-equivalent Y.Doc. Regression guard
	// for the multi-pod-autoscale case where pod B spins up after pod
	// A has been serving edits, and an incoming peer on pod B must see
	// current state, not an empty room.
	authoritative := crdt.New(crdt.WithClientID(serverClientID))
	text := authoritative.GetText(sharedTextName)
	authoritative.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, "Current state", nil)
	})
	snapshot := authoritative.EncodeStateAsUpdate()

	room, _ := newTestRoom(t)
	if err := room.BootstrapFromSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}

	// A client peer SyncStep1 must return the bootstrapped content.
	peer := newMockConn()
	p := newPeer(peer, room)
	room.AddPeer(p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.writeLoop(ctx)

	client := newYDocPeerForTest(t)
	step1 := append([]byte{msgTypeSync}, client.EncodeSyncStep1()...)
	room.handleMessage(p, step1)
	select {
	case reply := <-peer.writeCh:
		if err := client.ApplySyncMessage(reply[1:]); err != nil {
			t.Fatalf("client apply: %v", err)
		}
		if got := client.Text(); got != "Current state" {
			t.Errorf("client text after bootstrap: %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no SyncStep2 reply after bootstrap")
	}
}

func TestRoom_AppendsUpdatesToStateStore(t *testing.T) {
	// Every applied Update must land in the state store so a cold-
	// starting sibling pod can replay it. Fake store records appends
	// so we can assert the full payload reaches it.
	room, _ := newTestRoom(t)
	fake := &recordingStateStore{}
	room.SetStateStore(fake)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)

	client := newYDocPeerForTest(t)
	client.InsertText("hi")
	update := append([]byte{msgTypeSync}, client.EncodeUpdate()...)
	room.handleMessage(peer, update)

	// AppendUpdate is fire-and-forget on a goroutine; poll briefly.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(fake.Appends("test-doc")) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if appends := fake.Appends("test-doc"); len(appends) != 1 {
		t.Fatalf("expected 1 append to state store, got %d", len(appends))
	}
}

func TestRoom_Flush_WritesSnapshotToStateStore(t *testing.T) {
	// flushBuffer triggers WriteSnapshot so the state store has a
	// current snapshot after each flush window. Without this, the log
	// would grow unbounded and cold-start replay would get slower.
	room, srv := newTestRoom(t)
	_ = srv
	fake := &recordingStateStore{}
	room.SetStateStore(fake)
	room.BootstrapContent("seeded")

	// Force a dirty buffer so flushBuffer runs.
	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)
	client := newYDocPeerForTest(t)
	client.InsertText("x")
	room.handleMessage(peer, append([]byte{msgTypeSync}, client.EncodeUpdate()...))

	room.flushBuffer(time.Second)

	if len(fake.Snapshots("test-doc")) == 0 {
		t.Error("expected WriteSnapshot after flush, got none")
	}
}

// recordingStateStore captures all state-store interactions for tests.
type recordingStateStore struct {
	mu        stdsync.Mutex
	appends   map[string][][]byte
	snapshots map[string][][]byte
}

func (r *recordingStateStore) AppendUpdate(_ context.Context, docID string, update []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.appends == nil {
		r.appends = map[string][][]byte{}
	}
	cp := make([]byte, len(update))
	copy(cp, update)
	r.appends[docID] = append(r.appends[docID], cp)
	return nil
}

func (r *recordingStateStore) Appends(docID string) [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.appends[docID]
}

func (r *recordingStateStore) Snapshots(docID string) [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshots[docID]
}

func (r *recordingStateStore) ReadSnapshot(_ context.Context, _ string) ([]byte, int64, error) {
	return nil, 0, nil
}

func (r *recordingStateStore) ReadLogTail(_ context.Context, _ string, _ int64) ([][]byte, int64, error) {
	return nil, 0, nil
}

func (r *recordingStateStore) WriteSnapshot(_ context.Context, docID string, state []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.snapshots == nil {
		r.snapshots = map[string][][]byte{}
	}
	cp := make([]byte, len(state))
	copy(cp, state)
	r.snapshots[docID] = append(r.snapshots[docID], cp)
	return nil
}

func (r *recordingStateStore) Close() error { return nil }

func TestRoom_Update_TwoPeers_BidirectionalFanout(t *testing.T) {
	// Gap #2: previously we only tested peer A → peer B. Now both
	// directions AND verify that each peer's OWN update is not echoed
	// back (which would create a feedback loop in y-websocket clients).
	room, _ := newTestRoom(t)

	connA := newMockConn()
	peerA := newPeer(connA, room)
	room.AddPeer(peerA)
	connB := newMockConn()
	peerB := newPeer(connB, room)
	room.AddPeer(peerB)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peerA.writeLoop(ctx)
	go peerB.writeLoop(ctx)

	clientA := newYDocPeerForTest(t)
	clientA.InsertText("from-A")
	room.handleMessage(peerA, append([]byte{msgTypeSync}, clientA.EncodeUpdate()...))

	clientB := newYDocPeerForTest(t)
	clientB.InsertText("from-B")
	room.handleMessage(peerB, append([]byte{msgTypeSync}, clientB.EncodeUpdate()...))

	// Peer B sees A's update. Peer A sees B's update.
	readWithin := func(conn *mockConn) ([]byte, bool) {
		select {
		case got := <-conn.writeCh:
			return got, true
		case <-time.After(time.Second):
			return nil, false
		}
	}
	if _, ok := readWithin(connB); !ok {
		t.Error("peer B did not receive A's update")
	}
	if _, ok := readWithin(connA); !ok {
		t.Error("peer A did not receive B's update")
	}
	// Neither peer should receive a second message (no echo).
	select {
	case got := <-connA.writeCh:
		t.Errorf("peer A got a second (echoed?) frame: % x", got[:min(16, len(got))])
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case got := <-connB.writeCh:
		t.Errorf("peer B got a second frame: % x", got[:min(16, len(got))])
	case <-time.After(50 * time.Millisecond):
	}
}

func TestRoom_SyncStep2FromPeer_AppliesToYDoc(t *testing.T) {
	// Gap #5: symmetric catch-up case — a peer sends SYNC_STEP_2
	// (typically the reply to a server-initiated SYNC_STEP_1, or an
	// out-of-band catch-up push). The server must APPLY it to its
	// Y.Doc but NOT broadcast it (session-specific handshake frame).
	room, _ := newTestRoom(t)
	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)
	other := newMockConn()
	otherPeer := newPeer(other, room)
	room.AddPeer(otherPeer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)
	go otherPeer.writeLoop(ctx)

	// Construct a SyncStep2 by having the client play server for a
	// moment: it encodes its state as the reply to a blank SyncStep1.
	client := newYDocPeerForTest(t)
	client.InsertText("peer has extra content")
	// EncodeSyncStep2 from ygo/sync takes the step1 frame the client
	// would have received; easiest way to get one is from the empty
	// room itself.
	step1 := ysync.EncodeSyncStep1(crdt.New())
	step2, err := ysync.EncodeSyncStep2(client.doc, step1)
	if err != nil {
		t.Fatalf("EncodeSyncStep2: %v", err)
	}
	frame := append([]byte{msgTypeSync}, step2...)

	room.handleMessage(peer, frame)

	// Room.ydoc should now carry the client's content.
	if got := extractText(t, room); got != "peer has extra content" {
		t.Errorf("room state after SyncStep2 apply: got %q, want %q", got, "peer has extra content")
	}
	// The frame must NOT be broadcast to the other peer (SyncStep1/2
	// are session-specific).
	select {
	case got := <-other.writeCh:
		t.Errorf("SyncStep2 must not be broadcast; other peer got: % x", got[:min(16, len(got))])
	case <-time.After(50 * time.Millisecond):
	}
}

func TestRoom_ConcurrentUpdates_NoDataRace(t *testing.T) {
	// Gap #7: parallel handleSyncMessage calls exercise ydocMu. Under
	// `go test -race` this will flag any unguarded write to the Y.Doc.
	room, _ := newTestRoom(t)
	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)

	const n = 50
	done := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			client := newYDocPeerForTest(t)
			client.InsertText("x")
			frame := append([]byte{msgTypeSync}, client.EncodeUpdate()...)
			room.handleMessage(peer, frame)
		}(i)
	}
	for i := 0; i < n; i++ {
		<-done
	}
	// If the mutex isn't doing its job, -race will panic above; here
	// we just check the Y.Doc is still readable.
	if state := room.YDocState(); len(state) == 0 {
		t.Error("YDocState is empty after parallel updates")
	}
}

func TestRoom_Awareness_BroadcastsButDoesNotBuffer(t *testing.T) {
	room, _ := newTestRoom(t)
	connA := newMockConn()
	peerA := newPeer(connA, room)
	room.AddPeer(peerA)
	connB := newMockConn()
	peerB := newPeer(connB, room)
	room.AddPeer(peerB)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peerB.writeLoop(ctx)

	awareness := []byte{msgTypeAwareness, 0x02, 0xde, 0xad}
	room.handleMessage(peerA, awareness)

	select {
	case got := <-connB.writeCh:
		if string(got) != string(awareness) {
			t.Errorf("peer B received wrong awareness frame: got % x", got)
		}
	case <-time.After(time.Second):
		t.Fatal("awareness not broadcast")
	}

	if room.buffer.Len() != 0 {
		t.Errorf("awareness must not be buffered for persistence, buffer len=%d", room.buffer.Len())
	}
}
