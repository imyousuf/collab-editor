package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
	"github.com/reearth/ygo/crdt"
)

// --- Stubs ---

type stubStateStore struct {
	snapshot     []byte
	snapOffset   int64
	readErr      error
	logTail      [][]byte
	logTailErr   error
	readSnapCalls atomic.Int32
	readTailCalls atomic.Int32
	writeSnapCalls atomic.Int32
	appendCalls  atomic.Int32
}

func (s *stubStateStore) AppendUpdate(_ context.Context, _ string, _ []byte) error {
	s.appendCalls.Add(1)
	return nil
}
func (s *stubStateStore) ReadSnapshot(_ context.Context, _ string) ([]byte, int64, error) {
	s.readSnapCalls.Add(1)
	return s.snapshot, s.snapOffset, s.readErr
}
func (s *stubStateStore) ReadLogTail(_ context.Context, _ string, _ int64) ([][]byte, int64, error) {
	s.readTailCalls.Add(1)
	return s.logTail, s.snapOffset + int64(len(s.logTail)), s.logTailErr
}
func (s *stubStateStore) WriteSnapshot(_ context.Context, _ string, _ []byte) error {
	s.writeSnapCalls.Add(1)
	return nil
}
func (s *stubStateStore) Close() error { return nil }

// trackingProvider wraps a provider.Client hitting a test HTTP server
// whose Load handler flips a counter we can inspect.
type trackingProvider struct {
	*provider.Client
	loadCalls *atomic.Int32
	content   string
}

func newTrackingProvider(t *testing.T, content string) *trackingProvider {
	t.Helper()
	calls := &atomic.Int32{}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(spi.HealthResponse{Status: "ok"})
			return
		}
		if r.URL.Path == "/documents/load" {
			calls.Add(1)
			_ = json.NewEncoder(w).Encode(spi.LoadResponse{Content: content})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	cli := provider.NewClient(provider.ClientConfig{BaseURL: srv.URL})
	return &trackingProvider{Client: cli, loadCalls: calls, content: content}
}

func newTestServer(t *testing.T, content string) (*Server, *trackingProvider, *Metrics) {
	t.Helper()
	cfg := &Config{}
	cfg.Storage.LoadTimeout = time.Second
	cfg.Storage.StoreTimeout = time.Second
	cfg.Storage.Retry.MaxAttempts = 1
	cfg.Storage.Retry.InitialBackoff = time.Millisecond
	cfg.Room.FlushDebounce = time.Second
	cfg.Room.FlushMaxBytes = 1024 * 1024
	cfg.Room.IdleTimeout = time.Minute

	p := newTrackingProvider(t, content)
	metrics := NewMetrics()
	breaker := NewCircuitBreaker(p.Client, 5, time.Second, metrics)
	srv := NewServer(cfg, p.Client, breaker, metrics)
	return srv, p, metrics
}

// --- Bootstrap-order tests ---

func TestServer_BootstrapRoom_PrefersSnapshotOverProvider(t *testing.T) {
	// Regression guard for the Phase-2 cold-start priority. If someone
	// flips the order so provider.Load wins over the Redis snapshot,
	// a pod cold-starting into an active room would clobber live
	// state with the last-flushed content — silently dropping edits
	// between snapshot and flush.
	srv, provider, _ := newTestServer(t, "from provider")

	// Seed a snapshot representing "from snapshot".
	seed := crdt.New(crdt.WithClientID(serverClientID))
	seedText := seed.GetText(sharedTextName)
	seed.Transact(func(txn *crdt.Transaction) {
		seedText.Insert(txn, 0, "from snapshot", nil)
	})
	stub := &stubStateStore{snapshot: seed.EncodeStateAsUpdate()}
	srv.SetStateStore(stub)

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if got := room.ydoc.GetText(sharedTextName).ToString(); got != "from snapshot" {
		t.Errorf("content: got %q, want %q (snapshot must win over provider)", got, "from snapshot")
	}
	if got := provider.loadCalls.Load(); got != 0 {
		t.Errorf("provider.Load should NOT be called when a snapshot is present, got %d call(s)", got)
	}
	if got := stub.readSnapCalls.Load(); got != 1 {
		t.Errorf("expected 1 snapshot read, got %d", got)
	}
	if got := stub.readTailCalls.Load(); got != 1 {
		t.Errorf("expected 1 log-tail read after snapshot bootstrap, got %d", got)
	}
}

func TestServer_BootstrapRoom_FallsBackToProviderWhenNoSnapshot(t *testing.T) {
	// Absent-snapshot path: every request goes to the provider. This is
	// the single-pod or true-cold-cluster case, and is the flow the
	// dev stack uses today (no Redis).
	srv, provider, _ := newTestServer(t, "from provider")

	stub := &stubStateStore{} // no snapshot
	srv.SetStateStore(stub)

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if got := room.ydoc.GetText(sharedTextName).ToString(); got != "from provider" {
		t.Errorf("content: got %q, want %q", got, "from provider")
	}
	if got := provider.loadCalls.Load(); got != 1 {
		t.Errorf("provider.Load call count: got %d, want 1", got)
	}
	if got := stub.readTailCalls.Load(); got != 0 {
		t.Errorf("log-tail should NOT be read when no snapshot is present, got %d call(s)", got)
	}
}

func TestServer_BootstrapRoom_ReplaysLogTailOnTopOfSnapshot(t *testing.T) {
	// The snapshot bootstrap + log-tail apply is the cold-start
	// correctness path: tail updates written AFTER the snapshot must
	// still land on the fresh pod. Without this, updates produced
	// between flush-time and pod-boot-time would be missing.
	srv, _, _ := newTestServer(t, "ignored")

	seed := crdt.New(crdt.WithClientID(serverClientID))
	seedText := seed.GetText(sharedTextName)
	seed.Transact(func(txn *crdt.Transaction) {
		seedText.Insert(txn, 0, "snap ", nil)
	})
	snap := seed.EncodeStateAsUpdate()
	// A tail entry encoding " + tail".
	seed.Transact(func(txn *crdt.Transaction) {
		seedText.Insert(txn, 5, "+ tail", nil)
	})
	tailEntry := seed.EncodeStateAsUpdate()

	stub := &stubStateStore{snapshot: snap, logTail: [][]byte{tailEntry}}
	srv.SetStateStore(stub)

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if got := room.ydoc.GetText(sharedTextName).ToString(); got != "snap + tail" {
		t.Errorf("log-tail replay: got %q, want %q", got, "snap + tail")
	}
}

func TestServer_BootstrapRoom_SnapshotErrorFallsThroughToProvider(t *testing.T) {
	// A transient Redis failure on snapshot read must NOT prevent the
	// room from being usable. Fall through to the provider path.
	srv, provider, _ := newTestServer(t, "from provider")

	stub := &stubStateStore{readErr: context.DeadlineExceeded}
	srv.SetStateStore(stub)

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if got := room.ydoc.GetText(sharedTextName).ToString(); got != "from provider" {
		t.Errorf("content on snapshot-read-error: got %q, want %q", got, "from provider")
	}
	if got := provider.loadCalls.Load(); got != 1 {
		t.Errorf("provider.Load should be called as fallback, got %d", got)
	}
}

func TestServer_BootstrapRoom_InstallsStateStoreOnRoom(t *testing.T) {
	// Every Update applied to the Room must land in the state store,
	// which only works if bootstrapRoom installs it. Guard the wiring.
	srv, _, _ := newTestServer(t, "")
	stub := &stubStateStore{}
	srv.SetStateStore(stub)

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if room.stateStore != StateStore(stub) {
		t.Errorf("bootstrapRoom did not install the server's state store on the room")
	}
}

func TestServer_SetStateStore_WiresThroughToBootstrap(t *testing.T) {
	// Gap #8: cmd/relay/main.go calls Server.SetStateStore after
	// constructing the Redis store. If someone removes that call or
	// replaces SetStateStore with a setter that doesn't wire into
	// bootstrap, every room would use the noop store and Phase-2
	// durability would silently disappear. This test asserts that once
	// SetStateStore is called on the server, new rooms pick up that
	// store on bootstrap.
	srv, _, _ := newTestServer(t, "")
	stub := &stubStateStore{}
	srv.SetStateStore(stub)

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if room.stateStore != StateStore(stub) {
		t.Errorf("room.stateStore is %T, want the server's configured stub", room.stateStore)
	}
	if stub.readSnapCalls.Load() != 1 {
		t.Errorf("bootstrap did not read from the configured state store")
	}
}

func TestServer_BootstrapRoom_FallsBackToNoopWhenStateStoreUnset(t *testing.T) {
	// Single-pod / no-Redis: rooms still get a valid (noop) state store
	// so the AppendUpdate path in handleSyncMessage doesn't nil-deref.
	srv, _, _ := newTestServer(t, "hello")
	// Deliberately leave s.stateStore nil.

	room := NewRoom("doc", srv.config.Room, srv.Flusher(), srv.metrics)
	srv.bootstrapRoom(context.Background(), room, "doc")

	if room.stateStore == nil {
		t.Error("Room must have a non-nil state store after bootstrap")
	}
	// Noop ReadSnapshot returns nothing, so we should have fallen
	// through to provider.
	if got := room.ydoc.GetText(sharedTextName).ToString(); got != "hello" {
		t.Errorf("noop state store should have triggered provider load; got %q", got)
	}
}
