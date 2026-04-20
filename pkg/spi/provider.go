package spi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
)

// Provider is the interface that storage backends implement.
// The SDK handles HTTP routing, request parsing, and response encoding.
//
// Two integration modes:
//  1. Framework handler: use NewHTTPHandler() or GinHandler() to get a ready-made router
//  2. Manual: call ProcessLoadRequest() / ProcessStoreRequest() from your own controller
type Provider interface {
	// Load returns the document content and any stored Yjs updates.
	// Called when a new room is created and needs to bootstrap state.
	Load(ctx context.Context, documentID string) (*LoadResponse, error)

	// Store persists a batch of incremental Yjs updates.
	// Called periodically by the relay's flush loop.
	Store(ctx context.Context, documentID string, updates []UpdatePayload) (*StoreResponse, error)

	// Health returns the provider's health status.
	Health(ctx context.Context) (*HealthResponse, error)
}

// OptionalDelete is an optional interface that providers can implement
// to support document deletion.
type OptionalDelete interface {
	Delete(ctx context.Context, documentID string) error
}

// OptionalList is an optional interface that providers can implement
// to support listing documents.
type OptionalList interface {
	ListDocuments(ctx context.Context) ([]DocumentListEntry, error)
}

// --- Manual integration: process request bodies directly ---

// ProcessLoadRequest parses a load request body and delegates to the provider.
func ProcessLoadRequest(ctx context.Context, p Provider, documentID string) (*LoadResponse, error) {
	return p.Load(ctx, documentID)
}

// ProcessStoreRequest parses a store request body and delegates to the provider.
func ProcessStoreRequest(ctx context.Context, p Provider, documentID string, body []byte) (*StoreResponse, error) {
	var req StoreRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}
	return p.Store(ctx, documentID, req.Updates)
}

// --- Framework integration: ready-made HTTP handler ---

// NewHTTPHandler returns an http.Handler that routes requests to the provider.
// Mounts the standard SPI endpoints:
//
//	GET  /health
//	POST /documents/load?path={documentId}
//	POST /documents/updates?path={documentId}
//	DELETE /documents?path={documentId}        (if provider implements OptionalDelete)
//	GET  /documents                            (if provider implements OptionalList)
func NewHTTPHandler(p Provider) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		resp, err := p.Health(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, resp)
	})

	mux.HandleFunc("POST /documents/load", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		resp, err := p.Load(r.Context(), documentID)
		if err != nil {
			slog.Error("provider load failed", "doc", documentID, "err", err)
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if resp == nil {
			writeJSON(w, http.StatusOK, &LoadResponse{})
			return
		}
		writeJSON(w, http.StatusOK, resp)
	})

	mux.HandleFunc("POST /documents/updates", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		var req StoreRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		resp, err := p.Store(r.Context(), documentID, req.Updates)
		if err != nil {
			slog.Error("provider store failed", "doc", documentID, "err", err)
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		status := http.StatusAccepted
		if len(resp.Failed) > 0 {
			status = http.StatusMultiStatus // 207
		}
		writeJSON(w, status, resp)
	})

	// Optional: DELETE
	if dp, ok := p.(OptionalDelete); ok {
		mux.HandleFunc("DELETE /documents", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			if err := dp.Delete(r.Context(), documentID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusOK)
		})
	}

	// Optional: LIST
	if lp, ok := p.(OptionalList); ok {
		mux.HandleFunc("GET /documents", func(w http.ResponseWriter, r *http.Request) {
			docs, err := lp.ListDocuments(r.Context())
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"documents": docs})
		})
	}

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
