package storagedemo

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// validDocID matches only safe document IDs (alphanumeric, hyphens, underscores, dots).
var validDocID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

func validateDocID(docID string) error {
	if docID == "" || len(docID) > 255 || !validDocID.MatchString(docID) {
		return errors.New("invalid document ID")
	}
	return nil
}

// FileStore implements document storage backed by the local filesystem.
// Each document is stored as a single file in the base directory.
type FileStore struct {
	baseDir string
	mu      sync.RWMutex
}

func NewFileStore(baseDir string) (*FileStore, error) {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating base dir: %w", err)
	}
	yjsDir := filepath.Join(baseDir, ".yjs")
	if err := os.MkdirAll(yjsDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating yjs dir: %w", err)
	}
	return &FileStore{baseDir: baseDir}, nil
}

func (fs *FileStore) filePath(docID string) string {
	return filepath.Join(fs.baseDir, docID)
}

func (fs *FileStore) yjsPath(docID string) string {
	return filepath.Join(fs.baseDir, ".yjs", docID+".yjs")
}

// LoadDocument reads the document file and any stored Y.js updates.
// Returns Content (original text for initial seed) and Updates (persisted Y.js state).
func (fs *FileStore) LoadDocument(docID string) (*spi.LoadResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}

	fs.mu.RLock()
	defer fs.mu.RUnlock()

	path := fs.filePath(docID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // new document
		}
		return nil, fmt.Errorf("reading document: %w", err)
	}

	resp := &spi.LoadResponse{
		Content: string(data),
	}

	// Load stored Y.js updates if they exist
	yjsFile := fs.yjsPath(docID)
	if f, err := os.Open(yjsFile); err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024) // up to 1MB per line
		var seq uint64
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			seq++
			resp.Updates = append(resp.Updates, spi.UpdatePayload{
				Sequence: seq,
				Data:     line, // base64-encoded Y.js message
			})
		}
	}

	return resp, nil
}

// StoreUpdates appends Y.js update data to the document's .yjs journal file.
// The original document file is NOT modified — it serves as the initial seed.
func (fs *FileStore) StoreUpdates(docID string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	if len(updates) == 0 {
		return &spi.StoreResponse{Stored: 0}, nil
	}

	yjsFile := fs.yjsPath(docID)
	f, err := os.OpenFile(yjsFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("opening yjs file: %w", err)
	}
	defer f.Close()

	for _, u := range updates {
		if _, err := fmt.Fprintln(f, u.Data); err != nil {
			return nil, fmt.Errorf("writing yjs update: %w", err)
		}
	}

	return &spi.StoreResponse{
		Stored:            len(updates),
		DuplicatesIgnored: 0,
	}, nil
}

// DeleteDocument removes the document file.
func (fs *FileStore) DeleteDocument(docID string) error {
	if err := validateDocID(docID); err != nil {
		return err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	path := fs.filePath(docID)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("deleting document: %w", err)
	}
	return nil
}

// CompactDocument is a no-op for this simple file-based provider.
func (fs *FileStore) CompactDocument(docID string, req *spi.CompactRequest) (*spi.CompactResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}
	return &spi.CompactResponse{Compacted: true}, nil
}

// Healthy returns true if the base directory is writable.
func (fs *FileStore) Healthy() bool {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	testFile := filepath.Join(fs.baseDir, ".health-check")
	if err := os.WriteFile(testFile, []byte("ok"), 0o644); err != nil {
		return false
	}
	os.Remove(testFile)
	return true
}

// --- spi.Provider implementation ---

// Load implements spi.Provider.
func (fs *FileStore) Load(_ context.Context, documentID string) (*spi.LoadResponse, error) {
	resp, err := fs.LoadDocument(documentID)
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return &spi.LoadResponse{}, nil
	}
	resp.MimeType = detectMimeType(documentID)
	return resp, nil
}

// Store implements spi.Provider.
func (fs *FileStore) Store(_ context.Context, documentID string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
	return fs.StoreUpdates(documentID, updates)
}

// Health implements spi.Provider.
func (fs *FileStore) Health(_ context.Context) (*spi.HealthResponse, error) {
	resp := &spi.HealthResponse{Status: "ok", Storage: "connected"}
	if !fs.Healthy() {
		resp.Status = "degraded"
		resp.Storage = "disconnected"
	}
	return resp, nil
}

// --- spi.OptionalDelete implementation ---

// Delete implements spi.OptionalDelete.
func (fs *FileStore) Delete(_ context.Context, documentID string) error {
	return fs.DeleteDocument(documentID)
}

// --- spi.OptionalList implementation ---

// ListDocuments implements spi.OptionalList.
func (fs *FileStore) ListDocuments(_ context.Context) ([]spi.DocumentListEntry, error) {
	entries, err := os.ReadDir(fs.baseDir)
	if err != nil {
		return nil, fmt.Errorf("listing documents: %w", err)
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
	return docs, nil
}

// --- MIME type detection ---

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

// Compile-time interface assertions.
var (
	_ spi.Provider     = (*FileStore)(nil)
	_ spi.OptionalDelete = (*FileStore)(nil)
	_ spi.OptionalList   = (*FileStore)(nil)
)
