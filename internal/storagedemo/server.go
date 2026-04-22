package storagedemo

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

// NewServer creates the HTTP server for the demo storage provider.
// Core SPI endpoints are handled by spi.NewHTTPHandler (the Go SDK).
// Comments SPI endpoints are handled by spi.NewCommentsHTTPHandler.
// Auth middleware and the extra /documents/compact endpoint are layered on top.
//
// Passing a nil commentStore disables the Comments routes (all
// /comments-related paths return 404).
func NewServer(store *FileStore, commentStore *CommentStore, authToken string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	// Create processor with YDocEngine for Y.js content resolution.
	processor := spi.NewProviderProcessor(store, spi.NewYgoEngine, "source")

	// The SDK handler implements all standard SPI routes.
	// The processor resolves Y.js diffs to content before calling Store.
	spiHandler := spi.NewHTTPHandler(store, processor)

	// Comments handler (plain REST, no Y.js engine). Only mounted when a
	// comment store is supplied.
	var commentsHandler http.Handler
	if commentStore != nil {
		commentsHandler = spi.NewCommentsHTTPHandler(commentStore)
	}

	// Health is public — no auth required.
	r.Get("/health", spiHandler.ServeHTTP)

	// All document routes require auth.
	r.Group(func(r chi.Router) {
		r.Use(bearerAuth(authToken))

		// Delegate standard SPI document endpoints to the SDK handler.
		r.Post("/documents/load", spiHandler.ServeHTTP)
		r.Post("/documents/updates", spiHandler.ServeHTTP)
		r.Get("/documents", spiHandler.ServeHTTP)

		// Version history endpoints (SDK-handled).
		r.Get("/documents/versions", spiHandler.ServeHTTP)
		r.Post("/documents/versions", spiHandler.ServeHTTP)
		r.Get("/documents/versions/detail", spiHandler.ServeHTTP)

		// Client mapping endpoints (SDK-handled).
		r.Get("/documents/clients", spiHandler.ServeHTTP)
		r.Post("/documents/clients", spiHandler.ServeHTTP)

		// Extra endpoint not in the SDK.
		r.Post("/documents/compact", compactHandler(store))

		// Comments SPI (Comments SDK-handled). All /comments routes and
		// /capabilities are registered via the SDK; we just delegate.
		if commentsHandler != nil {
			r.Get("/capabilities", commentsHandler.ServeHTTP)
			r.Mount("/documents/comments", commentsHandler)
		}
	})

	// Demo-only config endpoint — NOT part of the SPI contract.
	// Allows the demo app to toggle auto-version creation.
	r.Get("/config/auto-version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"enabled": store.AutoVersion()})
	})
	r.Post("/config/auto-version", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "invalid request body"})
			return
		}
		store.SetAutoVersion(body.Enabled)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"enabled": body.Enabled})
	})

	return r
}

func bearerAuth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth when no token is configured (open dev mode)
			if token != "" {
				auth := r.Header.Get("Authorization")
				if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != token {
					http.Error(w, `{"error":"unauthorized","message":"invalid or missing bearer token"}`, http.StatusUnauthorized)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
