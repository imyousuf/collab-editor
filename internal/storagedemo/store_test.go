package storagedemo

import (
	"os"
	"path/filepath"
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
	resp, err := store.LoadDocument("nonexistent.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp != nil {
		t.Errorf("expected nil for new document, got %+v", resp)
	}
}

func TestLoadDocument_ExistingFile(t *testing.T) {
	store := newTestStore(t)

	// Write a seed file directly
	content := "# Hello World\n\nThis is a test document."
	os.WriteFile(filepath.Join(store.baseDir, "test.md"), []byte(content), 0o644)

	resp, err := store.LoadDocument("test.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
	if resp.Content != content {
		t.Errorf("content: got %q, want %q", resp.Content, content)
	}
}

func TestStoreAndLoad(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	updates := []spi.UpdatePayload{
		{Sequence: 1, Data: "# Updated Content\n\nNew text here.", ClientID: 100, CreatedAt: ts},
	}

	resp, err := store.StoreUpdates("doc.md", updates)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 1 {
		t.Errorf("stored: got %d, want 1", resp.Stored)
	}

	loadResp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if loadResp == nil {
		t.Fatal("expected non-nil load response")
	}
	if loadResp.Content != "# Updated Content\n\nNew text here." {
		t.Errorf("content: got %q", loadResp.Content)
	}
}

func TestStoreUpdates_LastWins(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	// Multiple updates — the last one's Data is written to the file
	updates := []spi.UpdatePayload{
		{Sequence: 1, Data: "first version", ClientID: 100, CreatedAt: ts},
		{Sequence: 2, Data: "second version", ClientID: 100, CreatedAt: ts},
		{Sequence: 3, Data: "third version", ClientID: 200, CreatedAt: ts},
	}

	resp, err := store.StoreUpdates("doc.md", updates)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 3 {
		t.Errorf("stored: got %d, want 3", resp.Stored)
	}

	loadResp, _ := store.LoadDocument("doc.md")
	if loadResp.Content != "third version" {
		t.Errorf("expected last update to win, got %q", loadResp.Content)
	}
}

func TestDeleteDocument(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	store.StoreUpdates("doc.md", []spi.UpdatePayload{
		{Sequence: 1, Data: "some content", ClientID: 100, CreatedAt: ts},
	})

	if err := store.DeleteDocument("doc.md"); err != nil {
		t.Fatal(err)
	}

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp != nil {
		t.Errorf("expected nil after delete, got %+v", resp)
	}
}

func TestDeleteDocument_Nonexistent(t *testing.T) {
	store := newTestStore(t)
	if err := store.DeleteDocument("nope.md"); err != nil {
		t.Errorf("deleting nonexistent doc should not error: %v", err)
	}
}

func TestHealthy(t *testing.T) {
	store := newTestStore(t)
	if !store.Healthy() {
		t.Error("expected healthy store")
	}
}

func TestValidateDocID_PathTraversal(t *testing.T) {
	store := newTestStore(t)

	_, err := store.LoadDocument("../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}

	_, err = store.LoadDocument("../secret")
	if err == nil {
		t.Error("expected error for relative path")
	}
}

func TestValidateDocID_ValidNames(t *testing.T) {
	store := newTestStore(t)

	validNames := []string{"welcome.md", "page.html", "script.py", "app.jsx", "my-doc", "doc_v2"}
	for _, name := range validNames {
		if err := validateDocID(name); err != nil {
			t.Errorf("expected %q to be valid, got error: %v", name, err)
		}
	}

	_ = store // use store to avoid unused
}
