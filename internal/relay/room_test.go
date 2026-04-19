package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

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

func TestRoom_HandleMessage_BuffersUpdates(t *testing.T) {
	room, _ := newTestRoom(t)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// Sync update message: type=0, subtype=2, followed by payload
	msg := []byte{0, 2, 0x01, 0x02, 0x03}
	room.handleMessage(peer, msg)

	if room.buffer.Len() != 1 {
		t.Errorf("buffer len: got %d, want 1", room.buffer.Len())
	}
}

func TestRoom_HandleMessage_IgnoresNonUpdateMessages(t *testing.T) {
	room, _ := newTestRoom(t)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// Awareness message (type=1)
	room.handleMessage(peer, []byte{1, 0x01, 0x02})
	if room.buffer.Len() != 0 {
		t.Error("awareness messages should not be buffered")
	}

	// Sync step 1 (type=0, subtype=0)
	room.handleMessage(peer, []byte{0, 0, 0x01})
	if room.buffer.Len() != 0 {
		t.Error("sync step 1 should not be buffered")
	}
}

func TestRoom_Close(t *testing.T) {
	room, _ := newTestRoom(t)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// Add some buffered data
	room.buffer.Append([]byte("test"), 100)

	room.Close()

	// After close, buffer should be drained (flushed)
	if room.buffer.Len() != 0 {
		t.Errorf("buffer should be drained after close, got %d", room.buffer.Len())
	}
}
