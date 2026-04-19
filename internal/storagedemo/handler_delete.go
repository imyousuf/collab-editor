package storagedemo

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

func (h *handlers) deleteDoc(w http.ResponseWriter, r *http.Request) {
	docID := chi.URLParam(r, "documentId")

	if err := h.store.DeleteDocument(docID); err != nil {
		writeJSON(w, http.StatusInternalServerError, spi.ErrorResponse{
			Error:   "internal_error",
			Message: err.Error(),
		})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
