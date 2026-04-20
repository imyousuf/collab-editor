package storagedemo

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

// NewServer creates the HTTP server for the demo storage provider.
// Core SPI endpoints are handled by spi.NewHTTPHandler (the Go SDK).
// Auth middleware and the extra /documents/compact endpoint are layered on top.
func NewServer(store *FileStore, authToken string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	// The SDK handler implements all standard SPI routes.
	spiHandler := spi.NewHTTPHandler(store)

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
