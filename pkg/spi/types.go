package spi

import "time"

// LoadRequest is the body sent to POST /documents/{documentId}/load.
type LoadRequest struct {
	StateVector string `json:"state_vector,omitempty"`
}

// LoadResponse is returned by the storage provider on document load.
type LoadResponse struct {
	Snapshot *SnapshotPayload  `json:"snapshot,omitempty"`
	Updates  []UpdatePayload   `json:"updates,omitempty"`
	Metadata *DocumentMetadata `json:"metadata,omitempty"`
	Content  string            `json:"content,omitempty"`   // plain text content of the document
	MimeType string            `json:"mime_type,omitempty"` // MIME type of the document
}

// SnapshotPayload represents a compacted document snapshot.
type SnapshotPayload struct {
	Data        string    `json:"data"`         // base64-encoded Yjs update
	StateVector string    `json:"state_vector"` // base64-encoded state vector
	CreatedAt   time.Time `json:"created_at"`
	UpdateCount int       `json:"update_count"`
}

// UpdatePayload represents a single incremental Yjs update.
type UpdatePayload struct {
	Sequence  uint64    `json:"sequence"`
	Data      string    `json:"data"`      // base64-encoded Yjs update
	ClientID  uint64    `json:"client_id"`
	CreatedAt time.Time `json:"created_at"`
}

// DocumentMetadata holds document-level metadata returned by the provider.
type DocumentMetadata struct {
	Format      string `json:"format"`
	Language    string `json:"language"`
	CreatedBy   string `json:"created_by"`
	Permissions string `json:"permissions"` // "read-only" | "read-write"
}

// StoreRequest is the body sent to POST /documents/{documentId}/updates.
type StoreRequest struct {
	Updates []UpdatePayload `json:"updates"`
}

// StoreResponse is returned after persisting updates.
type StoreResponse struct {
	Stored            int            `json:"stored"`
	DuplicatesIgnored int            `json:"duplicates_ignored"`
	Failed            []FailedUpdate `json:"failed,omitempty"`
}

// FailedUpdate describes a single update that failed to persist.
type FailedUpdate struct {
	Sequence uint64 `json:"sequence"`
	Error    string `json:"error"`
}

// CompactRequest is the body sent to POST /documents/{documentId}/compact.
type CompactRequest struct {
	Snapshot             SnapshotPayload `json:"snapshot"`
	ReplaceSequencesUpTo uint64          `json:"replace_sequences_up_to"`
}

// CompactResponse is returned after compaction.
type CompactResponse struct {
	Compacted         bool `json:"compacted"`
	UpdatesRemoved    int  `json:"updates_removed"`
	SnapshotSizeBytes int  `json:"snapshot_size_bytes"`
}

// DocumentListEntry represents a document in the listing response.
type DocumentListEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mime_type"`
}

// HealthResponse is returned by the provider's health endpoint.
type HealthResponse struct {
	Status  string `json:"status"`
	Storage string `json:"storage,omitempty"`
}
