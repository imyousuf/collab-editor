package storagedemo

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

// validDocID matches only safe document IDs (alphanumeric, hyphens, underscores, dots).
var validDocID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// validUUID matches UUID v4 format.
var validUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validateDocID(docID string) error {
	if docID == "" || len(docID) > 255 || !validDocID.MatchString(docID) {
		return errors.New("invalid document ID")
	}
	return nil
}

// FileStore implements document storage backed by the local filesystem.
// Each document is stored as a single file in the base directory.
type FileStore struct {
	baseDir     string
	mu          sync.RWMutex
	autoVersion bool // demo-only: create a version on every Store call
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

// SetAutoVersion enables/disables auto-version creation on every Store call.
// This is a demo-only feature, not part of the SPI contract.
func (fs *FileStore) SetAutoVersion(enabled bool) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.autoVersion = enabled
}

// AutoVersion returns whether auto-versioning is enabled.
func (fs *FileStore) AutoVersion() bool {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.autoVersion
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
func (fs *FileStore) Store(ctx context.Context, documentID string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
	resp, err := fs.StoreUpdates(documentID, updates)
	if err != nil {
		return nil, err
	}

	// Auto-version: create a version from current document state after storing updates
	if fs.AutoVersion() && resp.Stored > 0 {
		loadResp, loadErr := fs.Load(ctx, documentID)
		if loadErr == nil && loadResp != nil && loadResp.Content != "" {
			versionEntry, vErr := fs.CreateVersion(ctx, documentID, &spi.CreateVersionRequest{
				Content:  loadResp.Content,
				MimeType: loadResp.MimeType,
				Type:     "auto",
				Creator:  "system",
			})
			if vErr == nil && versionEntry != nil {
				resp.VersionCreated = versionEntry
			}
		}
	}

	return resp, nil
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

// --- spi.OptionalVersions implementation ---

func (fs *FileStore) versionsDir(docID string) string {
	return filepath.Join(fs.baseDir, ".versions", docID)
}

func (fs *FileStore) clientMappingsPath(docID string) string {
	return filepath.Join(fs.baseDir, ".clients", docID+".json")
}

// ListVersions implements spi.OptionalVersions.
func (fs *FileStore) ListVersions(_ context.Context, documentID string) ([]spi.VersionListEntry, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}

	fs.mu.RLock()
	defer fs.mu.RUnlock()

	dir := fs.versionsDir(documentID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading versions dir: %w", err)
	}

	var versions []spi.VersionListEntry
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var entry spi.VersionEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			continue
		}
		versions = append(versions, spi.VersionListEntry{
			ID:        entry.ID,
			CreatedAt: entry.CreatedAt,
			Type:      entry.Type,
			Label:     entry.Label,
			Creator:   entry.Creator,
			MimeType:  entry.MimeType,
		})
	}

	sort.Slice(versions, func(i, j int) bool {
		return versions[i].CreatedAt.After(versions[j].CreatedAt) // newest first
	})

	return versions, nil
}

// CreateVersion implements spi.OptionalVersions.
func (fs *FileStore) CreateVersion(_ context.Context, documentID string, req *spi.CreateVersionRequest) (*spi.VersionListEntry, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	dir := fs.versionsDir(documentID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("creating versions dir: %w", err)
	}

	id := uuid.New().String()
	now := time.Now().UTC()
	vType := req.Type
	if vType == "" {
		vType = "manual"
	}

	entry := spi.VersionEntry{
		ID:        id,
		CreatedAt: now,
		Type:      vType,
		Label:     req.Label,
		Creator:   req.Creator,
		Content:   req.Content,
		MimeType:  req.MimeType,
		Blame:     req.Blame,
	}

	data, err := json.Marshal(entry)
	if err != nil {
		return nil, fmt.Errorf("marshaling version: %w", err)
	}

	if err := os.WriteFile(filepath.Join(dir, id+".json"), data, 0o644); err != nil {
		return nil, fmt.Errorf("writing version file: %w", err)
	}

	return &spi.VersionListEntry{
		ID:        id,
		CreatedAt: now,
		Type:      vType,
		Label:     req.Label,
		Creator:   req.Creator,
		MimeType:  req.MimeType,
	}, nil
}

// GetVersion implements spi.OptionalVersions.
func (fs *FileStore) GetVersion(_ context.Context, documentID string, versionID string) (*spi.VersionEntry, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if !validUUID.MatchString(versionID) {
		return nil, errors.New("invalid version ID")
	}

	fs.mu.RLock()
	defer fs.mu.RUnlock()

	path := filepath.Join(fs.versionsDir(documentID), versionID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading version file: %w", err)
	}

	var entry spi.VersionEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return nil, fmt.Errorf("unmarshaling version: %w", err)
	}

	return &entry, nil
}

// --- spi.OptionalClientMappings implementation ---

// GetClientMappings implements spi.OptionalClientMappings.
func (fs *FileStore) GetClientMappings(_ context.Context, documentID string) ([]spi.ClientUserMapping, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}

	fs.mu.RLock()
	defer fs.mu.RUnlock()

	path := fs.clientMappingsPath(documentID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading client mappings: %w", err)
	}

	var mappings []spi.ClientUserMapping
	if err := json.Unmarshal(data, &mappings); err != nil {
		return nil, fmt.Errorf("unmarshaling client mappings: %w", err)
	}

	return mappings, nil
}

// StoreClientMappings implements spi.OptionalClientMappings.
func (fs *FileStore) StoreClientMappings(_ context.Context, documentID string, mappings []spi.ClientUserMapping) error {
	if err := validateDocID(documentID); err != nil {
		return err
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	dir := filepath.Join(fs.baseDir, ".clients")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating clients dir: %w", err)
	}

	// Merge with existing mappings (new entries override by client_id)
	existing := make(map[uint64]spi.ClientUserMapping)
	path := fs.clientMappingsPath(documentID)
	if data, err := os.ReadFile(path); err == nil {
		var old []spi.ClientUserMapping
		if err := json.Unmarshal(data, &old); err != nil {
			return fmt.Errorf("corrupt client mappings file: %w", err)
		}
		for _, m := range old {
			existing[m.ClientID] = m
		}
	}

	for _, m := range mappings {
		existing[m.ClientID] = m
	}

	merged := make([]spi.ClientUserMapping, 0, len(existing))
	for _, m := range existing {
		merged = append(merged, m)
	}

	data, err := json.Marshal(merged)
	if err != nil {
		return fmt.Errorf("marshaling client mappings: %w", err)
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("writing client mappings: %w", err)
	}

	return nil
}

// Compile-time interface assertions.
var (
	_ spi.Provider               = (*FileStore)(nil)
	_ spi.OptionalList           = (*FileStore)(nil)
	_ spi.OptionalVersions       = (*FileStore)(nil)
	_ spi.OptionalClientMappings = (*FileStore)(nil)
)
