package relay

import (
	"log/slog"
	"sync"
	"time"

	"github.com/imyousuf/collab-editor/internal/relay/yjsengine"
	"golang.org/x/sync/singleflight"
)

// RoomManager is a thread-safe registry of active rooms.
type RoomManager struct {
	rooms   sync.Map // map[string]*Room
	group   singleflight.Group
	config  RoomConfig
	flusher *Flusher
	metrics *Metrics
	engine  yjsengine.Engine // shared by all rooms; per-doc state lives inside
}

// NewRoomManager builds a RoomManager that hands the given engine to
// every Room it creates. Pass nil to fall back to an in-process ygo
// engine (typical for tests).
func NewRoomManager(cfg RoomConfig, flusher *Flusher, metrics *Metrics, engine yjsengine.Engine) *RoomManager {
	if engine == nil {
		engine = yjsengine.NewYgoEngine()
	}
	return &RoomManager{
		config:  cfg,
		flusher: flusher,
		metrics: metrics,
		engine:  engine,
	}
}

// GetOrCreate returns an existing room or creates a new one.
// The bootstrap function is called at most once per documentID.
func (rm *RoomManager) GetOrCreate(documentID string, bootstrap func(*Room) error) (*Room, error) {
	if v, ok := rm.rooms.Load(documentID); ok {
		return v.(*Room), nil
	}

	v, err, _ := rm.group.Do(documentID, func() (any, error) {
		if v, ok := rm.rooms.Load(documentID); ok {
			return v.(*Room), nil
		}

		room := NewRoom(documentID, rm.config, rm.flusher, rm.metrics, rm.engine)
		if err := bootstrap(room); err != nil {
			return nil, err
		}

		rm.rooms.Store(documentID, room)
		rm.metrics.RoomsActive.Inc()
		slog.Info("room created", "doc", documentID)
		return room, nil
	})

	if err != nil {
		return nil, err
	}
	return v.(*Room), nil
}

// Remove removes a room after an idle timeout.
func (rm *RoomManager) Remove(documentID string) {
	if v, ok := rm.rooms.LoadAndDelete(documentID); ok {
		room := v.(*Room)
		room.Close()
		rm.metrics.RoomsActive.Dec()
		slog.Info("room removed", "doc", documentID)
	}
}

// ScheduleRemoval schedules room removal after idle timeout if it's still empty.
func (rm *RoomManager) ScheduleRemoval(documentID string) {
	time.AfterFunc(rm.config.IdleTimeout, func() {
		if v, ok := rm.rooms.Load(documentID); ok {
			room := v.(*Room)
			if room.PeerCount() == 0 {
				rm.Remove(documentID)
			}
		}
	})
}

// CloseAll closes all rooms (for graceful shutdown).
func (rm *RoomManager) CloseAll() {
	rm.rooms.Range(func(key, value any) bool {
		room := value.(*Room)
		room.Close()
		rm.rooms.Delete(key)
		rm.metrics.RoomsActive.Dec()
		return true
	})
}
