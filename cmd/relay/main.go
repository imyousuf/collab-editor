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
	"github.com/imyousuf/collab-editor/pkg/spi"
	"github.com/redis/go-redis/v9"
)

func writeProxyError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

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

	// Optional Comments provider client. When ProviderURL is empty, comments
	// are disabled globally and /api/documents/comments/* routes 404.
	var commentsClient *provider.CommentsClient
	if cfg.Comments.ProviderURL != "" {
		commentsClient = provider.NewCommentsClient(provider.CommentsClientConfig{
			BaseURL:   cfg.Comments.ProviderURL,
			AuthToken: cfg.Comments.AuthToken,
			Timeout:   cfg.Comments.Timeout,
		})
		slog.Info("comments provider configured", "url", cfg.Comments.ProviderURL)
	}

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

	// Set up Redis broker and flush lock if enabled
	if cfg.Redis.Enabled {
		opts, err := redis.ParseURL(cfg.Redis.URL)
		if err != nil {
			slog.Error("invalid redis URL", "url", cfg.Redis.URL, "err", err)
			os.Exit(1)
		}
		opts.Password = cfg.Redis.Password
		opts.DB = cfg.Redis.DB
		opts.PoolSize = cfg.Redis.PoolSize

		rdb := redis.NewClient(opts)
		if err := rdb.Ping(context.Background()).Err(); err != nil {
			slog.Error("failed to connect to Redis", "err", err)
			os.Exit(1)
		}
		defer rdb.Close()

		broker := relay.NewRedisBroker(rdb)
		srv.SetBroker(broker)
		srv.SetStateStore(relay.NewRedisStateStore(rdb, broker))
		srv.Flusher().SetFlushLock(relay.NewRedisFlushLock(rdb))
		slog.Info("redis broker + state store enabled", "url", cfg.Redis.URL)
	}

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

				// Version history proxy
				r.Get("/documents/versions", func(w http.ResponseWriter, r *http.Request) {
					path := r.URL.Query().Get("path")
					if path == "" {
						writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
						return
					}
					versions, err := providerClient.ListVersions(r.Context(), path)
					if err != nil {
						writeProxyError(w, http.StatusBadGateway, err.Error())
						return
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{"versions": versions})
				})

				r.Post("/documents/versions", func(w http.ResponseWriter, r *http.Request) {
					path := r.URL.Query().Get("path")
					if path == "" {
						writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
						return
					}
					var req spi.CreateVersionRequest
					if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
						writeProxyError(w, http.StatusBadRequest, "invalid request body")
						return
					}
					entry, err := providerClient.CreateVersion(r.Context(), path, &req)
					if err != nil {
						writeProxyError(w, http.StatusBadGateway, err.Error())
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(entry)
				})

				r.Get("/documents/versions/detail", func(w http.ResponseWriter, r *http.Request) {
					path := r.URL.Query().Get("path")
					versionID := r.URL.Query().Get("version")
					if path == "" {
						writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
						return
					}
					if versionID == "" {
						writeProxyError(w, http.StatusBadRequest, "missing 'version' query parameter")
						return
					}
					entry, err := providerClient.GetVersion(r.Context(), path, versionID)
					if err != nil {
						writeProxyError(w, http.StatusBadGateway, err.Error())
						return
					}
					if entry == nil {
						writeProxyError(w, http.StatusNotFound, "version not found")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(entry)
				})

				// Client mappings proxy
				r.Get("/documents/clients", func(w http.ResponseWriter, r *http.Request) {
					path := r.URL.Query().Get("path")
					if path == "" {
						writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
						return
					}
					mappings, err := providerClient.GetClientMappings(r.Context(), path)
					if err != nil {
						writeProxyError(w, http.StatusBadGateway, err.Error())
						return
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{"mappings": mappings})
				})

				r.Post("/documents/clients", func(w http.ResponseWriter, r *http.Request) {
					path := r.URL.Query().Get("path")
					if path == "" {
						writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
						return
					}
					var body struct {
						Mappings []spi.ClientUserMapping `json:"mappings"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						writeProxyError(w, http.StatusBadRequest, "invalid request body")
						return
					}
					if err := providerClient.StoreClientMappings(r.Context(), path, body.Mappings); err != nil {
						writeProxyError(w, http.StatusBadGateway, err.Error())
						return
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{"stored": len(body.Mappings)})
				})

				// Relay-level meta endpoint: lets the frontend discover whether
				// comments are configured at all without hitting the comments
				// provider. Returns 200 with {"comments_supported": bool}.
				r.Get("/capabilities", func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{
						"comments_supported": commentsClient != nil,
					})
				})

				// Comments proxy. All routes return 503 when comments are not
				// configured so the frontend can distinguish "not configured"
				// from "misbehaving provider".
				registerCommentsProxy(r, commentsClient)
			})
		},
	}

	// Start WebSocket transport
	go func() {
		slog.Info("websocket transport starting", "addr", cfg.Server.Addr)
		if err := transport.Serve(ctx, srv.HandleConnection); err != nil {
			slog.Error("websocket transport failed", "err", err)
		}
	}()

	// Start gRPC transport if enabled
	var grpcTransport *relay.GRPCTransport
	if cfg.GRPC.Enabled {
		grpcTransport = &relay.GRPCTransport{Addr: cfg.GRPC.Addr}
		go func() {
			slog.Info("grpc transport starting", "addr", cfg.GRPC.Addr)
			if err := grpcTransport.Serve(ctx, srv.HandleConnection); err != nil {
				slog.Error("grpc transport failed", "err", err)
			}
		}()
	}

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
