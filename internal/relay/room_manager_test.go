package relay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

func newTestRoomManager(t *testing.T) *RoomManager {
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
		FlushDebounce:   2 * time.Second,
		FlushMaxBytes:   65536,
		IdleTimeout:     100 * time.Millisecond,
		MaxPeersPerRoom: 50,
	}
	return NewRoomManager(cfg, flusher, metrics)
}

func TestRoomManager_GetOrCreate(t *testing.T) {
	rm := newTestRoomManager(t)

	room1, err := rm.GetOrCreate("doc-1", func(r *Room) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if room1 == nil {
		t.Fatal("expected non-nil room")
	}

	// Second call should return same room
	room2, err := rm.GetOrCreate("doc-1", func(r *Room) error {
		t.Error("bootstrap should not be called for existing room")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if room1 != room2 {
		t.Error("expected same room instance")
	}
}

func TestRoomManager_ConcurrentGetOrCreate(t *testing.T) {
	rm := newTestRoomManager(t)

	var bootstrapCount atomic.Int32
	var wg sync.WaitGroup

	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rm.GetOrCreate("doc-1", func(r *Room) error {
				bootstrapCount.Add(1)
				return nil
			})
		}()
	}
	wg.Wait()

	if count := bootstrapCount.Load(); count != 1 {
		t.Errorf("bootstrap called %d times, want 1 (singleflight)", count)
	}
}

func TestRoomManager_Remove(t *testing.T) {
	rm := newTestRoomManager(t)

	rm.GetOrCreate("doc-1", func(r *Room) error { return nil })
	rm.Remove("doc-1")

	// Should create a new room
	var bootstrapped bool
	rm.GetOrCreate("doc-1", func(r *Room) error {
		bootstrapped = true
		return nil
	})
	if !bootstrapped {
		t.Error("expected bootstrap after remove")
	}
}

func TestRoomManager_CloseAll(t *testing.T) {
	rm := newTestRoomManager(t)

	rm.GetOrCreate("doc-1", func(r *Room) error { return nil })
	rm.GetOrCreate("doc-2", func(r *Room) error { return nil })

	rm.CloseAll()

	// Both should be gone
	var count int
	rm.rooms.Range(func(_, _ any) bool {
		count++
		return true
	})
	if count != 0 {
		t.Errorf("expected 0 rooms after CloseAll, got %d", count)
	}
}
