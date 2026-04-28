package relay

import (
	"context"

	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/internal/relay/yjsengine"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server is the main relay server.
type Server struct {
	config     *Config
	rooms      *RoomManager
	provider   *provider.Client
	breaker    *CircuitBreaker
	metrics    *Metrics
	broker     MessageBroker // optional: for cross-instance pub/sub
	stateStore StateStore    // optional: durable event log + snapshot for multi-pod
}

// NewServer wires the Server with its dependencies. The engine is
// optional — pass nil to fall back to an in-process ygo engine. Use
// NewServerWithEngine when injecting the supervised sidecar engine
// from cmd/relay/main.go.
func NewServer(cfg *Config, providerClient *provider.Client, breaker *CircuitBreaker, metrics *Metrics) *Server {
	return NewServerWithEngine(cfg, providerClient, breaker, metrics, nil)
}

// NewServerWithEngine is the engine-aware constructor used by main.go
// when the relay is configured to run with the sidecar.
func NewServerWithEngine(cfg *Config, providerClient *provider.Client, breaker *CircuitBreaker, metrics *Metrics, engine yjsengine.Engine) *Server {
	flusher := NewFlusher(
		providerClient, breaker, metrics,
		cfg.Storage.Retry.MaxAttempts,
		cfg.Storage.Retry.InitialBackoff,
	)

	return &Server{
		config:   cfg,
		rooms:    NewRoomManager(cfg.Room, flusher, metrics, engine),
		provider: providerClient,
		breaker:  breaker,
		metrics:  metrics,
	}
}

// SetBroker sets the message broker for cross-instance scaling.
func (s *Server) SetBroker(broker MessageBroker) {
	s.broker = broker
}

// SetStateStore installs a StateStore for durable per-room Y.Doc state.
// Required for multi-pod deployments where a fresh pod needs to
// reconstruct a room's state without depending on sibling pods.
func (s *Server) SetStateStore(store StateStore) {
	s.stateStore = store
}

// stateStoreOrDefault returns the configured state store or a no-op
// fallback so rooms always have a non-nil dependency.
func (s *Server) stateStoreOrDefault() StateStore {
	if s.stateStore == nil {
		return NewNoopStateStore()
	}
	return s.stateStore
}

// bootstrapRoom initializes a newly-created Room with its state source.
// Exported-to-tests to let us assert the bootstrap order without spinning
// up a full transport + peer loop.
//
// Priority:
//  1. Redis snapshot (+ log tail). A freshly-autoscaled pod joining an
//     already-active room catches up from Redis without depending on
//     sibling pods being reachable.
//  2. Storage provider's Load. Either this is a true cold start (Redis
//     empty for this room) or Redis is unconfigured (single-pod mode).
//     Seeds via the pinned server ClientID so multi-pod bootstraps
//     converge deterministically.
func (s *Server) bootstrapRoom(ctx context.Context, room *Room, documentID string) {
	store := s.stateStoreOrDefault()
	room.SetStateStore(store)

	snapshot, snapOff, stateErr := store.ReadSnapshot(ctx, documentID)
	if stateErr != nil {
		slog.Warn("state store read snapshot failed", "doc", documentID, "err", stateErr)
	}

	if len(snapshot) > 0 {
		if err := room.BootstrapFromSnapshot(snapshot); err != nil {
			slog.Warn("bootstrap from snapshot failed", "doc", documentID, "err", err)
		} else {
			slog.Info("bootstrapped from state-store snapshot", "doc", documentID, "size", len(snapshot), "log_offset", snapOff)
		}
		if tail, _, tailErr := store.ReadLogTail(ctx, documentID, snapOff); tailErr == nil {
			for _, entry := range tail {
				if err := room.ApplyLogEntry(entry); err != nil {
					slog.Warn("log-tail replay failed", "doc", documentID, "err", err)
				}
			}
			if len(tail) > 0 {
				slog.Info("replayed state-store log tail", "doc", documentID, "entries", len(tail))
			}
		} else {
			slog.Warn("state store read log-tail failed", "doc", documentID, "err", tailErr)
		}
		return
	}

	// No snapshot → fall back to the storage provider's plain-text Load.
	resp, loadErr := s.provider.Load(ctx, documentID, "")
	if loadErr != nil {
		slog.Error("failed to load document from provider", "doc", documentID, "err", loadErr)
		return
	}
	if resp != nil && resp.Content != "" {
		room.BootstrapContent(resp.Content)
		slog.Info("loaded document content", "doc", documentID, "size", len(resp.Content))
	}
}

// Flusher returns the flusher used by room managers.
func (s *Server) Flusher() *Flusher {
	return s.rooms.flusher
}

// HandleConnection processes a single WebSocket connection.
// This is the ConnectionHandler passed to the Transport.
func (s *Server) HandleConnection(ctx context.Context, documentID string, conn Conn) error {
	room, err := s.rooms.GetOrCreate(documentID, func(room *Room) error {
		loadCtx, cancel := context.WithTimeout(ctx, s.config.Storage.LoadTimeout)
		defer cancel()
		s.bootstrapRoom(loadCtx, room, documentID)

		// Start the flush goroutine for this room — uses its own
		// background context so it survives individual connection closures.
		go room.StartFlushLoop(s.config.Storage.StoreTimeout)

		// If a broker is configured, add a broker peer for cross-instance relay.
		// The broker peer's readLoop feeds Redis messages into the room,
		// and its writeLoop publishes local broadcasts to Redis.
		if s.broker != nil {
			bConn, bErr := newBrokerConn(s.broker, documentID)
			if bErr != nil {
				slog.Error("failed to create broker peer", "doc", documentID, "err", bErr)
			} else {
				brokerPeer := newPeer(bConn, room)
				room.AddPeer(brokerPeer)
				go brokerPeer.writeLoop(context.Background())
				go brokerPeer.readLoop(context.Background())
			}
		}

		return nil
	})
	if err != nil {
		return err
	}

	peer := newPeer(conn, room)
	room.AddPeer(peer)

	// Start write loop in background
	writeCtx, writeCancel := context.WithCancel(ctx)
	defer writeCancel()
	go peer.writeLoop(writeCtx)

	// No history replay here: the peer's own y-websocket client sends a
	// SyncStep1 as its first frame, and our Room.handleSyncMessage
	// responds with a SyncStep2 drawn from the server-side Y.Doc. That
	// single exchange carries all state the peer is missing.

	// Read loop blocks until disconnect
	peer.readLoop(ctx)

	// Cleanup
	peer.Close()
	conn.Close(1000, "going away")

	if room.RemovePeer(peer) {
		// Last peer left — schedule room removal after idle timeout
		s.rooms.ScheduleRemoval(documentID)
	}

	return nil
}

// HealthHandler returns the relay health endpoint.
func (s *Server) HealthHandler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if s.breaker.State() == BreakerOpen {
			status = "degraded"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": status})
	})
	return r
}

// MetricsHandler returns the Prometheus metrics handler.
func (s *Server) MetricsHandler() http.Handler {
	return promhttp.HandlerFor(s.metrics.Registry, promhttp.HandlerOpts{})
}

// Shutdown performs graceful shutdown of all rooms.
func (s *Server) Shutdown() {
	slog.Info("shutting down all rooms")
	s.rooms.CloseAll()
}
