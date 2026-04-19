package storagedemo

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// NewServer creates the HTTP server for the demo storage provider.
func NewServer(store *FileStore, authToken string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	h := &handlers{store: store}

	r.Get("/health", h.health)

	r.Group(func(r chi.Router) {
		r.Use(bearerAuth(authToken))
		r.Post("/documents/{documentId}/load", h.load)
		r.Post("/documents/{documentId}/updates", h.storeUpdates)
		r.Post("/documents/{documentId}/compact", h.compact)
		r.Delete("/documents/{documentId}", h.deleteDoc)
	})

	return r
}

func bearerAuth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != token {
				http.Error(w, `{"error":"unauthorized","message":"invalid or missing bearer token"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type handlers struct {
	store *FileStore
}
