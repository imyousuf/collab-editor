package storagedemo

import (
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
	return &FileStore{baseDir: baseDir}, nil
}

func (fs *FileStore) filePath(docID string) string {
	return filepath.Join(fs.baseDir, docID)
}

// LoadDocument reads the document file and returns its text content.
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

	return &spi.LoadResponse{
		Content: string(data),
	}, nil
}

// StoreUpdates writes the document content back to the file.
// In this simple provider, each "update" contains the full document text in the Data field.
func (fs *FileStore) StoreUpdates(docID string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	// Use the last update's data as the current document content
	if len(updates) == 0 {
		return &spi.StoreResponse{Stored: 0}, nil
	}

	lastUpdate := updates[len(updates)-1]
	path := fs.filePath(docID)

	if err := os.WriteFile(path, []byte(lastUpdate.Data), 0o644); err != nil {
		return nil, fmt.Errorf("writing document: %w", err)
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
