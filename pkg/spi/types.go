package spi

import "time"

// LoadRequest is the body sent to POST /documents/{documentId}/load.
type LoadRequest struct {
	StateVector string `json:"state_vector,omitempty"`
}

// LoadResponse is returned by the storage provider on document load.
// Providers return the latest resolved document content. No Y.js concepts.
type LoadResponse struct {
	Content  string            `json:"content,omitempty"`   // latest resolved document text
	MimeType string            `json:"mime_type,omitempty"` // MIME type of the document
	Metadata *DocumentMetadata `json:"metadata,omitempty"`
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
// The SDK resolves Y.js diffs and populates Content with the latest document text.
// Providers receive both the resolved content and the raw updates — they can store
// however they see fit, but Load must always return the resolved content.
type StoreRequest struct {
	Updates  []UpdatePayload `json:"updates"`
	Content  string          `json:"content,omitempty"`   // resolved document text (populated by SDK)
	MimeType string          `json:"mime_type,omitempty"` // document MIME type
}

// StoreResponse is returned after persisting updates.
type StoreResponse struct {
	Stored            int              `json:"stored"`
	DuplicatesIgnored int              `json:"duplicates_ignored"`
	Failed            []FailedUpdate   `json:"failed,omitempty"`
	VersionCreated    *VersionListEntry `json:"version_created,omitempty"`
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

// --- Version History ---

// VersionEntry is the full version record returned by GetVersion.
// Includes content (plain text) and optionally blame segments.
type VersionEntry struct {
	ID        string         `json:"id"`
	CreatedAt time.Time      `json:"created_at"`
	Type      string         `json:"type"`             // "auto" | "manual"
	Label     string         `json:"label,omitempty"`
	Creator   string         `json:"creator,omitempty"`
	Content   string         `json:"content"`
	MimeType  string         `json:"mime_type,omitempty"`
	Blame     []BlameSegment `json:"blame,omitempty"`
}

// VersionListEntry is a lightweight version summary for list responses.
// Does not include content or blame data.
type VersionListEntry struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	Type      string    `json:"type"`
	Label     string    `json:"label,omitempty"`
	Creator   string    `json:"creator,omitempty"`
	MimeType  string    `json:"mime_type,omitempty"`
}

// BlameSegment attributes a character range to a user.
// Color is NOT included — the frontend assigns colors from a palette.
type BlameSegment struct {
	Start    int    `json:"start"`     // character offset (inclusive)
	End      int    `json:"end"`       // character offset (exclusive)
	UserName string `json:"user_name"`
}

// CreateVersionRequest is the body sent to create a new version.
type CreateVersionRequest struct {
	Content  string         `json:"content"`
	MimeType string         `json:"mime_type,omitempty"`
	Label    string         `json:"label,omitempty"`
	Creator  string         `json:"creator,omitempty"`
	Type     string         `json:"type,omitempty"` // defaults to "manual"
	Blame    []BlameSegment `json:"blame,omitempty"`
}

// --- Client User Mappings ---

// ClientUserMapping maps a Yjs client ID to a user identity.
// Used for blame attribution across sessions.
type ClientUserMapping struct {
	ClientID uint64 `json:"client_id"`
	UserName string `json:"user_name"`
}
