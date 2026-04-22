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
	// Load returns the latest resolved document content.
	// Called when a new room is created and needs to bootstrap state.
	Load(ctx context.Context, documentID string) (*LoadResponse, error)

	// Store persists the document state. Receives the resolved content
	// (latest full text) and optionally raw Y.js updates.
	// Called periodically by the relay's flush loop via the SDK processor.
	Store(ctx context.Context, documentID string, req *StoreRequest) (*StoreResponse, error)

	// Health returns the provider's health status.
	Health(ctx context.Context) (*HealthResponse, error)
}

// OptionalList is an optional interface that providers can implement
// to support listing documents.
type OptionalList interface {
	ListDocuments(ctx context.Context) ([]DocumentListEntry, error)
}

// OptionalVersions is an optional interface that providers can implement
// to support document version history.
type OptionalVersions interface {
	// ListVersions returns lightweight version summaries (no content or blame).
	ListVersions(ctx context.Context, documentID string) ([]VersionListEntry, error)

	// CreateVersion stores a new version snapshot.
	CreateVersion(ctx context.Context, documentID string, req *CreateVersionRequest) (*VersionListEntry, error)

	// GetVersion returns a full version with content and blame data.
	GetVersion(ctx context.Context, documentID string, versionID string) (*VersionEntry, error)
}

// OptionalClientMappings is an optional interface that providers can implement
// to persist Yjs client-ID-to-user mappings (for blame attribution across sessions).
type OptionalClientMappings interface {
	GetClientMappings(ctx context.Context, documentID string) ([]ClientUserMapping, error)
	StoreClientMappings(ctx context.Context, documentID string, mappings []ClientUserMapping) error
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
	return p.Store(ctx, documentID, &req)
}

// --- Framework integration: ready-made HTTP handler ---

// NewHTTPHandler returns an http.Handler that routes requests to the provider.
// If a ProviderProcessor is provided, Store requests are resolved via the
// Y.Doc engine before calling the provider. If processor is nil, requests
// pass through directly (provider must handle content resolution itself).
//
// Mounts the standard SPI endpoints:
//
//	GET  /health
//	POST /documents/load?path={documentId}
//	POST /documents/updates?path={documentId}
//	GET  /documents                                                      (if OptionalList)
//	GET  /documents/versions?path={documentId}                           (if OptionalVersions)
//	POST /documents/versions?path={documentId}                           (if OptionalVersions)
//	GET  /documents/versions/detail?path={documentId}&version={versionId}(if OptionalVersions)
//	GET  /documents/clients?path={documentId}                            (if OptionalClientMappings)
//	POST /documents/clients?path={documentId}                            (if OptionalClientMappings)
func NewHTTPHandler(p Provider, processor ...*ProviderProcessor) http.Handler {
	var proc *ProviderProcessor
	if len(processor) > 0 {
		proc = processor[0]
	}
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
		// Resolve Y.js diffs to content via the processor
		if proc != nil {
			proc.ResolveStore(documentID, &req)
		}
		resp, err := p.Store(r.Context(), documentID, &req)
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

	// Optional: VERSIONS
	if vp, ok := p.(OptionalVersions); ok {
		mux.HandleFunc("GET /documents/versions", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			versions, err := vp.ListVersions(r.Context(), documentID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
		})

		mux.HandleFunc("POST /documents/versions", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			var req CreateVersionRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
				return
			}
			entry, err := vp.CreateVersion(r.Context(), documentID, &req)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusCreated, entry)
		})

		mux.HandleFunc("GET /documents/versions/detail", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			versionID := r.URL.Query().Get("version")
			if versionID == "" {
				writeError(w, http.StatusBadRequest, "missing 'version' query parameter")
				return
			}
			entry, err := vp.GetVersion(r.Context(), documentID, versionID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if entry == nil {
				writeError(w, http.StatusNotFound, "version not found")
				return
			}
			writeJSON(w, http.StatusOK, entry)
		})
	}

	// Optional: CLIENT MAPPINGS
	if cmp, ok := p.(OptionalClientMappings); ok {
		mux.HandleFunc("GET /documents/clients", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			mappings, err := cmp.GetClientMappings(r.Context(), documentID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"mappings": mappings})
		})

		mux.HandleFunc("POST /documents/clients", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			var body struct {
				Mappings []ClientUserMapping `json:"mappings"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
				return
			}
			if err := cmp.StoreClientMappings(r.Context(), documentID, body.Mappings); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"stored": len(body.Mappings)})
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
