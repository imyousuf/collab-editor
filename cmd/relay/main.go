package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/internal/relay"
)

func main() {
	configPath := flag.String("config", "", "path to config file")
	flag.Parse()

	cfg, err := relay.LoadConfig(*configPath)
	if err != nil {
		slog.Error("failed to load config", "err", err)
		os.Exit(1)
	}

	var handler slog.Handler
	if cfg.Log.Format == "json" {
		handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.Log.Level)})
	} else {
		handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.Log.Level)})
	}
	slog.SetDefault(slog.New(handler))

	// Create provider client
	providerClient := provider.NewClient(provider.ClientConfig{
		BaseURL:      cfg.Storage.ProviderURL,
		AuthToken:    cfg.Storage.AuthToken,
		LoadTimeout:  cfg.Storage.LoadTimeout,
		StoreTimeout: cfg.Storage.StoreTimeout,
	})

	// Create metrics and circuit breaker
	metrics := relay.NewMetrics()
	breaker := relay.NewCircuitBreaker(
		providerClient,
		cfg.Storage.HealthCheck.Threshold,
		cfg.Storage.HealthCheck.Interval,
		metrics,
	)

	// Create server
	srv := relay.NewServer(&cfg, providerClient, breaker, metrics)

	// Set up context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start health check loop
	go breaker.StartHealthCheck(ctx)

	// Start metrics server if enabled
	if cfg.Metrics.Enabled {
		metricsLn, err := net.Listen("tcp", cfg.Metrics.Addr)
		if err != nil {
			slog.Error("failed to start metrics listener", "err", err)
			os.Exit(1)
		}
		metricsSrv := &http.Server{Handler: srv.MetricsHandler()}
		go func() {
			slog.Info("metrics server starting", "addr", cfg.Metrics.Addr)
			if err := metricsSrv.Serve(metricsLn); err != nil && err != http.ErrServerClosed {
				slog.Error("metrics server failed", "err", err)
			}
		}()
		defer metricsSrv.Close()
	}

	// Start health HTTP endpoint alongside WebSocket transport
	healthLn, err := net.Listen("tcp", cfg.Server.Addr)
	if err != nil {
		slog.Error("failed to start health listener", "err", err)
		os.Exit(1)
	}

	// Create transport that shares the same listener
	transport := &relay.WSTransport{
		Listener:           healthLn,
		InsecureSkipVerify: true,
		ExtraRoutes: func(r chi.Router) {
			r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
				status := "ok"
				if breaker.State() == relay.BreakerOpen {
					status = "degraded"
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]string{"status": status})
			})

			// REST API endpoints — frontend talks to these, relay proxies to provider
			r.Route("/api", func(r chi.Router) {
				r.Get("/documents", func(w http.ResponseWriter, r *http.Request) {
					docs, err := providerClient.ListDocuments(r.Context())
					if err != nil {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusBadGateway)
						json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
						return
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{"documents": docs})
				})

				r.Post("/documents/load", func(w http.ResponseWriter, r *http.Request) {
					path := r.URL.Query().Get("path")
					if path == "" {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusBadRequest)
						json.NewEncoder(w).Encode(map[string]string{"error": "missing 'path' query parameter"})
						return
					}
					resp, err := providerClient.Load(r.Context(), path, "")
					if err != nil {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusBadGateway)
						json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
						return
					}
					if resp.Content == "" {
						w.WriteHeader(http.StatusNoContent)
						return
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(resp)
				})
			})
		},
	}

	// Start WebSocket transport (blocks until ctx is cancelled)
	go func() {
		slog.Info("relay server starting", "addr", cfg.Server.Addr)
		if err := transport.Serve(ctx, srv.HandleConnection); err != nil {
			slog.Error("transport failed", "err", err)
		}
	}()

	// Wait for signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down relay")
	cancel()

	// Graceful shutdown: flush all rooms
	srv.Shutdown()

	time.Sleep(100 * time.Millisecond) // Brief pause for final flushes
	slog.Info("relay shutdown complete")
}

func parseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
