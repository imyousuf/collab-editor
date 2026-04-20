package storagedemo

import (
	"encoding/json"
	"net/http"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func compactHandler(store *FileStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID := r.URL.Query().Get("path")
		if docID == "" {
			writeJSON(w, http.StatusBadRequest, spi.ErrorResponse{
				Error:   "bad_request",
				Message: "missing 'path' query parameter",
			})
			return
		}

		var req spi.CompactRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, spi.ErrorResponse{
				Error:   "bad_request",
				Message: "invalid request body",
			})
			return
		}

		resp, err := store.CompactDocument(docID, &req)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, spi.ErrorResponse{
				Error:   "internal_error",
				Message: err.Error(),
			})
			return
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
