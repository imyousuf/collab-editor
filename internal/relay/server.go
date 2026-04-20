package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server is the main relay server.
type Server struct {
	config   *Config
	rooms    *RoomManager
	provider *provider.Client
	breaker  *CircuitBreaker
	metrics  *Metrics
}

func NewServer(cfg *Config, providerClient *provider.Client, breaker *CircuitBreaker, metrics *Metrics) *Server {
	flusher := NewFlusher(
		providerClient, breaker, metrics,
		cfg.Storage.Retry.MaxAttempts,
		cfg.Storage.Retry.InitialBackoff,
	)

	return &Server{
		config:   cfg,
		rooms:    NewRoomManager(cfg.Room, flusher, metrics),
		provider: providerClient,
		breaker:  breaker,
		metrics:  metrics,
	}
}

// HandleConnection processes a single WebSocket connection.
// This is the ConnectionHandler passed to the Transport.
func (s *Server) HandleConnection(ctx context.Context, documentID string, conn Conn) error {
	room, err := s.rooms.GetOrCreate(documentID, func(room *Room) error {
		// Bootstrap: load document state from provider
		loadCtx, cancel := context.WithTimeout(ctx, s.config.Storage.LoadTimeout)
		defer cancel()

		resp, loadErr := s.provider.Load(loadCtx, documentID, "")
		if loadErr != nil {
			slog.Error("failed to load document from provider", "doc", documentID, "err", loadErr)
			return nil
		}

		// If the provider returned stored Y.js updates, decode and set them
		// for replay to newly connecting peers.
		if resp != nil && len(resp.Updates) > 0 {
			msgs := make([][]byte, 0, len(resp.Updates))
			for _, u := range resp.Updates {
				decoded, err := base64.StdEncoding.DecodeString(u.Data)
				if err != nil {
					slog.Warn("skipping corrupted stored update", "doc", documentID, "err", err)
					continue
				}
				msgs = append(msgs, decoded)
			}
			if len(msgs) > 0 {
				room.SetStoredMessages(msgs)
				slog.Info("loaded stored Y.js state", "doc", documentID, "updates", len(msgs))
			}
		}

		// Start the flush goroutine for this room
		go room.StartFlushLoop(ctx)

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

	// Replay stored messages to the peer before starting the read loop.
	// This bootstraps the peer's Y.Doc with persisted state.
	room.SendStoredMessages(peer)

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
