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

func TestRoom_HandleMessage_RelaysAllTypes(t *testing.T) {
	room, _ := newTestRoom(t)

	conn1 := newMockConn()
	conn2 := newMockConn()
	peer1 := newPeer(conn1, room)
	peer2 := newPeer(conn2, room)
	room.AddPeer(peer1)
	room.AddPeer(peer2)

	// Sync update message relayed to peer2
	msg := []byte{0, 2, 0x01, 0x02, 0x03}
	room.handleMessage(peer1, msg)

	select {
	case got := <-peer2.writeCh:
		if string(got) != string(msg) {
			t.Errorf("peer2 got %v, want %v", got, msg)
		}
	default:
		t.Error("peer2 should receive relayed message")
	}

	// Awareness message also relayed
	awareness := []byte{1, 0x01, 0x02}
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

func TestRoom_HandleMessage_BuffersSyncMessages(t *testing.T) {
	room, _ := newTestRoom(t)
	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// Sync message (type 0x00) should be buffered
	syncMsg := []byte{0x00, 0x02, 0x01, 0x02, 0x03}
	room.handleMessage(peer, syncMsg)

	if room.buffer.Len() != 1 {
		t.Errorf("buffer.Len() = %d, want 1", room.buffer.Len())
	}

	// Awareness message (type 0x01) should NOT be buffered
	awarenessMsg := []byte{0x01, 0x01, 0x02}
	room.handleMessage(peer, awarenessMsg)

	if room.buffer.Len() != 1 {
		t.Errorf("buffer.Len() = %d, want 1 (awareness should be skipped)", room.buffer.Len())
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

	// Send a sync message that exceeds threshold
	syncMsg := []byte{0x00, 0x02, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a}
	room.handleMessage(peer, syncMsg)

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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		room.StartFlushLoop(ctx)
		close(done)
	}()

	// Wait for flush to drain the buffer
	time.Sleep(150 * time.Millisecond)

	if room.buffer.Len() != 0 {
		t.Errorf("buffer should be drained by flush loop, got Len() = %d", room.buffer.Len())
	}

	cancel()
	<-done
}

func TestRoom_FlushLoop_FinalFlushOnClose(t *testing.T) {
	room, _ := newTestRoom(t)
	room.config.FlushDebounce = 10 * time.Second // long enough that timer won't fire

	// Add messages to buffer
	room.buffer.Append([]byte{0x00, 0x02, 0x01}, 0)
	room.buffer.Append([]byte{0x00, 0x02, 0x02}, 0)

	ctx := context.Background()
	done := make(chan struct{})
	go func() {
		room.StartFlushLoop(ctx)
		close(done)
	}()

	// Close the room — should trigger final flush
	room.Close()
	<-done

	if room.buffer.Len() != 0 {
		t.Errorf("buffer should be drained on close, got Len() = %d", room.buffer.Len())
	}
}

func TestRoom_StoredMessages_SetAndSend(t *testing.T) {
	room, _ := newTestRoom(t)

	conn := newMockConn()
	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// Start write loop so Send() works
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go peer.writeLoop(ctx)

	// Set stored messages
	msgs := [][]byte{
		{0x00, 0x02, 0x01},
		{0x00, 0x02, 0x02},
	}
	room.SetStoredMessages(msgs)

	// Send stored messages to peer
	room.SendStoredMessages(peer)

	// Verify peer received both messages
	for i, expected := range msgs {
		select {
		case got := <-conn.writeCh:
			if string(got) != string(expected) {
				t.Errorf("msg %d: got %v, want %v", i, got, expected)
			}
		case <-time.After(time.Second):
			t.Fatalf("timeout waiting for stored message %d", i)
		}
	}
}

func TestRoom_StoredMessages_EmptyIsNoOp(t *testing.T) {
	room, _ := newTestRoom(t)
	conn := newMockConn()
	peer := newPeer(conn, room)

	// No stored messages set — SendStoredMessages should not panic
	room.SendStoredMessages(peer)

	select {
	case <-conn.writeCh:
		t.Error("should not send anything when no stored messages")
	default:
		// expected
	}
}
