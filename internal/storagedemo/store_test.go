package storagedemo

import (
	"os"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func newTestStore(t *testing.T) *FileStore {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestLoadDocument_NewDocument(t *testing.T) {
	store := newTestStore(t)
	resp, err := store.LoadDocument("nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	if resp != nil {
		t.Errorf("expected nil for new document, got %+v", resp)
	}
}

func TestStoreAndLoad(t *testing.T) {
	store := newTestStore(t)
	ts := time.Date(2026, 4, 14, 10, 0, 0, 0, time.UTC)

	updates := []spi.UpdatePayload{
		{Sequence: 1, Data: "dGVzdDE=", ClientID: 100, CreatedAt: ts},
		{Sequence: 2, Data: "dGVzdDI=", ClientID: 200, CreatedAt: ts},
	}

	resp, err := store.StoreUpdates("doc-1", updates)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 2 {
		t.Errorf("stored: got %d, want 2", resp.Stored)
	}
	if resp.DuplicatesIgnored != 0 {
		t.Errorf("dupes: got %d, want 0", resp.DuplicatesIgnored)
	}

	loadResp, err := store.LoadDocument("doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if loadResp == nil {
		t.Fatal("expected non-nil load response")
	}
	if len(loadResp.Updates) != 2 {
		t.Fatalf("expected 2 updates, got %d", len(loadResp.Updates))
	}
	if loadResp.Updates[0].Sequence != 1 || loadResp.Updates[1].Sequence != 2 {
		t.Errorf("wrong sequence order: %d, %d", loadResp.Updates[0].Sequence, loadResp.Updates[1].Sequence)
	}
}

func TestStoreUpdates_Idempotent(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	updates := []spi.UpdatePayload{
		{Sequence: 1, Data: "data", ClientID: 100, CreatedAt: ts},
	}

	// First store
	resp1, _ := store.StoreUpdates("doc-1", updates)
	if resp1.Stored != 1 || resp1.DuplicatesIgnored != 0 {
		t.Errorf("first store: stored=%d, dupes=%d", resp1.Stored, resp1.DuplicatesIgnored)
	}

	// Second store (same sequence)
	resp2, _ := store.StoreUpdates("doc-1", updates)
	if resp2.Stored != 0 || resp2.DuplicatesIgnored != 1 {
		t.Errorf("second store: stored=%d, dupes=%d", resp2.Stored, resp2.DuplicatesIgnored)
	}
}

func TestDeleteDocument(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	store.StoreUpdates("doc-1", []spi.UpdatePayload{
		{Sequence: 1, Data: "data", ClientID: 100, CreatedAt: ts},
	})

	if err := store.DeleteDocument("doc-1"); err != nil {
		t.Fatal(err)
	}

	resp, err := store.LoadDocument("doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp != nil {
		t.Errorf("expected nil after delete, got %+v", resp)
	}
}

func TestDeleteDocument_Nonexistent(t *testing.T) {
	store := newTestStore(t)
	if err := store.DeleteDocument("nope"); err != nil {
		t.Errorf("deleting nonexistent doc should not error: %v", err)
	}
}

func TestCompactDocument(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	// Store 3 updates
	store.StoreUpdates("doc-1", []spi.UpdatePayload{
		{Sequence: 1, Data: "d1", ClientID: 100, CreatedAt: ts},
		{Sequence: 2, Data: "d2", ClientID: 100, CreatedAt: ts},
		{Sequence: 3, Data: "d3", ClientID: 200, CreatedAt: ts},
	})

	// Compact up to sequence 2
	compactResp, err := store.CompactDocument("doc-1", &spi.CompactRequest{
		Snapshot: spi.SnapshotPayload{
			Data:        "snapshot_data",
			StateVector: "sv_data",
			CreatedAt:   ts,
			UpdateCount: 2,
		},
		ReplaceSequencesUpTo: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !compactResp.Compacted {
		t.Error("expected compacted=true")
	}
	if compactResp.UpdatesRemoved != 2 {
		t.Errorf("updates removed: got %d, want 2", compactResp.UpdatesRemoved)
	}

	// Load should return snapshot + 1 remaining update (seq 3)
	loadResp, err := store.LoadDocument("doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if loadResp.Snapshot == nil {
		t.Fatal("expected snapshot after compaction")
	}
	if loadResp.Snapshot.Data != "snapshot_data" {
		t.Errorf("snapshot data: got %q", loadResp.Snapshot.Data)
	}
	if len(loadResp.Updates) != 1 {
		t.Fatalf("expected 1 remaining update, got %d", len(loadResp.Updates))
	}
	if loadResp.Updates[0].Sequence != 3 {
		t.Errorf("remaining update seq: got %d, want 3", loadResp.Updates[0].Sequence)
	}
}

func TestNextSequence(t *testing.T) {
	store := newTestStore(t)

	if seq := store.NextSequence("doc-1"); seq != 1 {
		t.Errorf("empty doc: got %d, want 1", seq)
	}

	ts := time.Now().UTC()
	store.StoreUpdates("doc-1", []spi.UpdatePayload{
		{Sequence: 5, Data: "d", ClientID: 100, CreatedAt: ts},
		{Sequence: 10, Data: "d", ClientID: 100, CreatedAt: ts},
	})

	if seq := store.NextSequence("doc-1"); seq != 11 {
		t.Errorf("after updates: got %d, want 11", seq)
	}
}

func TestHealthy(t *testing.T) {
	store := newTestStore(t)
	if !store.Healthy() {
		t.Error("expected healthy store")
	}

	// Make base dir unwritable
	badStore, _ := NewFileStore("/nonexistent/path/that/wont/exist")
	if badStore != nil {
		// If it was somehow created, remove it
		os.RemoveAll("/nonexistent/path/that/wont/exist")
	}
}
