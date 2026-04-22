package storagedemo

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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

func TestStore_WritesVersionedContent(t *testing.T) {
	store := newTestStore(t)

	// Create the original document file (seed content)
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	req := &spi.StoreRequest{
		Content:  "# Updated Content",
		MimeType: "text/markdown",
	}

	resp, err := store.Store(context.Background(), "doc.md", req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 0 {
		t.Errorf("stored: got %d, want 0 (no updates)", resp.Stored)
	}

	// Original seed file should NOT be modified
	content, _ := os.ReadFile(filepath.Join(store.baseDir, "doc.md"))
	if string(content) != "# Seed" {
		t.Errorf("seed file modified: got %q", string(content))
	}

	// Load should return the versioned content, not the seed
	loadResp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if loadResp.Content != "# Updated Content" {
		t.Errorf("Load after Store: got %q, want %q", loadResp.Content, "# Updated Content")
	}
}

func TestStore_MultipleStoresReturnLatest(t *testing.T) {
	store := newTestStore(t)

	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	// First store
	store.Store(context.Background(), "doc.md", &spi.StoreRequest{Content: "Version 1"})

	// Second store
	store.Store(context.Background(), "doc.md", &spi.StoreRequest{Content: "Version 2"})

	// Load should return the latest
	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "Version 2" {
		t.Errorf("expected %q, got %q", "Version 2", resp.Content)
	}
}

func TestLoadDocument_FallsBackToSeed(t *testing.T) {
	store := newTestStore(t)

	// Only seed file, no stores yet
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Seed" {
		t.Errorf("Content: got %q, want %q", resp.Content, "# Seed")
	}
}

func TestLoadDocument_NoYjsFile(t *testing.T) {
	store := newTestStore(t)

	// Only seed file, no .yjs
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Seed" {
		t.Errorf("Content: got %q", resp.Content)
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
