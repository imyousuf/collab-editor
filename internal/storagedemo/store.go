package storagedemo

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// validDocID matches only safe document IDs (alphanumeric, hyphens, underscores, dots).
var validDocID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// validateDocID ensures a document ID is safe for filesystem operations.
func validateDocID(docID string) error {
	if docID == "" || len(docID) > 255 || !validDocID.MatchString(docID) {
		return errors.New("invalid document ID")
	}
	return nil
}

// FileStore implements document storage backed by the local filesystem.
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

func (fs *FileStore) docDir(docID string) string {
	return filepath.Join(fs.baseDir, docID)
}

func (fs *FileStore) updatesDir(docID string) string {
	return filepath.Join(fs.docDir(docID), "updates")
}

// LoadDocument loads the document's snapshot and any subsequent updates.
func (fs *FileStore) LoadDocument(docID string) (*spi.LoadResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}

	fs.mu.RLock()
	defer fs.mu.RUnlock()

	dir := fs.docDir(docID)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return nil, nil // new document
	}

	resp := &spi.LoadResponse{}

	// Load snapshot if it exists
	snapPath := filepath.Join(dir, "snapshot.meta.json")
	if data, err := os.ReadFile(snapPath); err == nil {
		var snap spi.SnapshotPayload
		if err := json.Unmarshal(data, &snap); err == nil {
			resp.Snapshot = &snap
		}
	}

	// Load updates after the snapshot's max compacted sequence
	var afterSeq uint64
	compactSeqPath := filepath.Join(dir, "snapshot.seq")
	if data, err := os.ReadFile(compactSeqPath); err == nil {
		afterSeq, _ = strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	}

	updates, err := fs.readUpdates(docID, afterSeq)
	if err == nil && len(updates) > 0 {
		resp.Updates = updates
	}

	// Load metadata
	metaPath := filepath.Join(dir, "metadata.json")
	if data, err := os.ReadFile(metaPath); err == nil {
		var meta spi.DocumentMetadata
		if err := json.Unmarshal(data, &meta); err == nil {
			resp.Metadata = &meta
		}
	}

	return resp, nil
}

// StoreUpdates persists a batch of incremental updates.
func (fs *FileStore) StoreUpdates(docID string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	updDir := fs.updatesDir(docID)
	if err := os.MkdirAll(updDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating updates dir: %w", err)
	}

	stored := 0
	dupes := 0

	for _, u := range updates {
		metaPath := filepath.Join(updDir, fmt.Sprintf("%06d.meta.json", u.Sequence))

		// Idempotency check
		if _, err := os.Stat(metaPath); err == nil {
			dupes++
			continue
		}

		data, err := json.Marshal(u)
		if err != nil {
			return nil, fmt.Errorf("marshaling update %d: %w", u.Sequence, err)
		}

		if err := os.WriteFile(metaPath, data, 0o644); err != nil {
			return nil, fmt.Errorf("writing update %d: %w", u.Sequence, err)
		}
		stored++
	}

	return &spi.StoreResponse{
		Stored:            stored,
		DuplicatesIgnored: dupes,
	}, nil
}

// DeleteDocument removes all data for a document.
func (fs *FileStore) DeleteDocument(docID string) error {
	if err := validateDocID(docID); err != nil {
		return err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	dir := fs.docDir(docID)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return nil
	}
	return os.RemoveAll(dir)
}

// CompactDocument replaces accumulated updates with a single snapshot.
func (fs *FileStore) CompactDocument(docID string, req *spi.CompactRequest) (*spi.CompactResponse, error) {
	if err := validateDocID(docID); err != nil {
		return nil, err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	dir := fs.docDir(docID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("creating doc dir: %w", err)
	}

	// Write new snapshot metadata
	snapData, err := json.Marshal(req.Snapshot)
	if err != nil {
		return nil, fmt.Errorf("marshaling snapshot: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "snapshot.meta.json"), snapData, 0o644); err != nil {
		return nil, fmt.Errorf("writing snapshot: %w", err)
	}

	// Store the max compacted sequence for accurate load filtering
	seqData := []byte(strconv.FormatUint(req.ReplaceSequencesUpTo, 10))
	if err := os.WriteFile(filepath.Join(dir, "snapshot.seq"), seqData, 0o644); err != nil {
		return nil, fmt.Errorf("writing snapshot sequence: %w", err)
	}

	// Remove updates up to the specified sequence
	removed := 0
	updDir := fs.updatesDir(docID)
	entries, _ := os.ReadDir(updDir)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		seqStr := strings.TrimSuffix(e.Name(), ".meta.json")
		seq, err := strconv.ParseUint(seqStr, 10, 64)
		if err != nil {
			continue
		}
		if seq <= req.ReplaceSequencesUpTo {
			os.Remove(filepath.Join(updDir, e.Name()))
			removed++
		}
	}

	return &spi.CompactResponse{
		Compacted:         true,
		UpdatesRemoved:    removed,
		SnapshotSizeBytes: len(snapData),
	}, nil
}

// NextSequence returns the next available sequence number for a document.
func (fs *FileStore) NextSequence(docID string) uint64 {
	updDir := fs.updatesDir(docID)
	entries, err := os.ReadDir(updDir)
	if err != nil {
		return 1
	}

	var maxSeq uint64
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		seqStr := strings.TrimSuffix(e.Name(), ".meta.json")
		seq, err := strconv.ParseUint(seqStr, 10, 64)
		if err != nil {
			continue
		}
		if seq > maxSeq {
			maxSeq = seq
		}
	}
	return maxSeq + 1
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

func (fs *FileStore) readUpdates(docID string, afterSeq uint64) ([]spi.UpdatePayload, error) {
	updDir := fs.updatesDir(docID)
	entries, err := os.ReadDir(updDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	type seqEntry struct {
		seq  uint64
		name string
	}
	var seqEntries []seqEntry

	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		seqStr := strings.TrimSuffix(e.Name(), ".meta.json")
		seq, err := strconv.ParseUint(seqStr, 10, 64)
		if err != nil {
			continue
		}
		if seq > afterSeq {
			seqEntries = append(seqEntries, seqEntry{seq: seq, name: e.Name()})
		}
	}

	sort.Slice(seqEntries, func(i, j int) bool {
		return seqEntries[i].seq < seqEntries[j].seq
	})

	var updates []spi.UpdatePayload
	for _, se := range seqEntries {
		data, err := os.ReadFile(filepath.Join(updDir, se.name))
		if err != nil {
			continue
		}
		var u spi.UpdatePayload
		if err := json.Unmarshal(data, &u); err != nil {
			continue
		}
		updates = append(updates, u)
	}

	return updates, nil
}
