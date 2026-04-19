package storagedemo

import (
	"encoding/json"
	"net/http"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func (h *handlers) health(w http.ResponseWriter, r *http.Request) {
	resp := spi.HealthResponse{Status: "ok", Storage: "connected"}
	if !h.store.Healthy() {
		resp.Status = "degraded"
		resp.Storage = "disconnected"
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(resp)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
