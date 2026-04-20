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

func TestStoreUpdates_AppendsToYjsFile(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	// Create the original document file (seed content)
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	updates := []spi.UpdatePayload{
		{Sequence: 1, Data: "AQID", ClientID: 100, CreatedAt: ts}, // base64 of some bytes
	}

	resp, err := store.StoreUpdates("doc.md", updates)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 1 {
		t.Errorf("stored: got %d, want 1", resp.Stored)
	}

	// Original file should NOT be modified
	content, _ := os.ReadFile(filepath.Join(store.baseDir, "doc.md"))
	if string(content) != "# Seed" {
		t.Errorf("original file modified: got %q", string(content))
	}

	// .yjs file should exist with the update
	yjsContent, _ := os.ReadFile(store.yjsPath("doc.md"))
	if string(yjsContent) != "AQID\n" {
		t.Errorf("yjs file: got %q, want %q", string(yjsContent), "AQID\n")
	}
}

func TestStoreUpdates_AppendsMultiple(t *testing.T) {
	store := newTestStore(t)
	ts := time.Now().UTC()

	// First batch
	store.StoreUpdates("doc.md", []spi.UpdatePayload{
		{Sequence: 1, Data: "first", ClientID: 100, CreatedAt: ts},
		{Sequence: 2, Data: "second", ClientID: 100, CreatedAt: ts},
	})

	// Second batch (appends)
	store.StoreUpdates("doc.md", []spi.UpdatePayload{
		{Sequence: 3, Data: "third", ClientID: 200, CreatedAt: ts},
	})

	yjsContent, _ := os.ReadFile(store.yjsPath("doc.md"))
	if string(yjsContent) != "first\nsecond\nthird\n" {
		t.Errorf("yjs file: got %q", string(yjsContent))
	}
}

func TestLoadDocument_WithYjsUpdates(t *testing.T) {
	store := newTestStore(t)

	// Seed file
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	// Store some Y.js updates
	ts := time.Now().UTC()
	store.StoreUpdates("doc.md", []spi.UpdatePayload{
		{Sequence: 1, Data: "update1", ClientID: 100, CreatedAt: ts},
		{Sequence: 2, Data: "update2", ClientID: 100, CreatedAt: ts},
	})

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Seed" {
		t.Errorf("Content: got %q, want %q", resp.Content, "# Seed")
	}
	if len(resp.Updates) != 2 {
		t.Fatalf("Updates: got %d, want 2", len(resp.Updates))
	}
	if resp.Updates[0].Data != "update1" {
		t.Errorf("Updates[0].Data: got %q", resp.Updates[0].Data)
	}
	if resp.Updates[1].Data != "update2" {
		t.Errorf("Updates[1].Data: got %q", resp.Updates[1].Data)
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
	if len(resp.Updates) != 0 {
		t.Errorf("Updates: got %d, want 0", len(resp.Updates))
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
