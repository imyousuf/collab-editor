package storagedemo

import (
	"net/http"
	"os"
)

func (h *handlers) listDocuments(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(h.store.baseDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "internal_error",
			"message": err.Error(),
		})
		return
	}

	type docEntry struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}

	var docs []docEntry
	for _, e := range entries {
		if e.IsDir() || e.Name() == ".health-check" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		docs = append(docs, docEntry{
			Name: e.Name(),
			Size: info.Size(),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"documents": docs,
	})
}
