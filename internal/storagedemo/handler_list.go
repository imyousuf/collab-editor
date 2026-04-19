package storagedemo

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

var mimeTypes = map[string]string{
	".md":   "text/markdown",
	".html": "text/html",
	".htm":  "text/html",
	".py":   "text/x-python",
	".js":   "text/javascript",
	".jsx":  "text/jsx",
	".ts":   "text/typescript",
	".tsx":  "text/tsx",
	".css":  "text/css",
	".json": "application/json",
	".xml":  "application/xml",
	".yaml": "text/yaml",
	".yml":  "text/yaml",
	".go":   "text/x-go",
	".rs":   "text/x-rust",
	".java": "text/x-java",
	".txt":  "text/plain",
}

func detectMimeType(name string) string {
	ext := filepath.Ext(name)
	if mt, ok := mimeTypes[ext]; ok {
		return mt
	}
	return "text/plain"
}

func (h *handlers) listDocuments(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(h.store.baseDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "internal_error",
			"message": err.Error(),
		})
		return
	}

	var docs []spi.DocumentListEntry
	for _, e := range entries {
		if e.IsDir() || e.Name() == ".health-check" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		docs = append(docs, spi.DocumentListEntry{
			Name:     e.Name(),
			Size:     info.Size(),
			MimeType: detectMimeType(e.Name()),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"documents": docs,
	})
}
