package storagedemo

import (
	"encoding/json"
	"net/http"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func (h *handlers) load(w http.ResponseWriter, r *http.Request) {
	docID := r.URL.Query().Get("path")
	if docID == "" {
		writeJSON(w, http.StatusBadRequest, spi.ErrorResponse{
			Error:   "bad_request",
			Message: "missing 'path' query parameter",
		})
		return
	}

	var req spi.LoadRequest
	if r.Body != nil && r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, spi.ErrorResponse{
				Error:   "bad_request",
				Message: "invalid request body",
			})
			return
		}
	}

	resp, err := h.store.LoadDocument(docID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, spi.ErrorResponse{
			Error:   "internal_error",
			Message: err.Error(),
		})
		return
	}

	if resp == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
