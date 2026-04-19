package storagedemo

import (
	"net/http"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func (h *handlers) deleteDoc(w http.ResponseWriter, r *http.Request) {
	docID := r.URL.Query().Get("path")
	if docID == "" {
		writeJSON(w, http.StatusBadRequest, spi.ErrorResponse{
			Error:   "bad_request",
			Message: "missing 'path' query parameter",
		})
		return
	}

	if err := h.store.DeleteDocument(docID); err != nil {
		writeJSON(w, http.StatusInternalServerError, spi.ErrorResponse{
			Error:   "internal_error",
			Message: err.Error(),
		})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
