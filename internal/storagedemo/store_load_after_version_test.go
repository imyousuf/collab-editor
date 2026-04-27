package storagedemo

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// Bug B: a CreateVersion call (which is what auto-snapshots and the
// frontend's "Save" button invoke) must influence what LoadDocument
// returns. Without this, every page reload returns the seed file
// content — discarding all accepted edits captured by the auto-snapshot
// path.
//
// The relay's flush path that calls Store() with non-empty content
// would also keep the Load journal up-to-date (and continues to,
// post-fix). But CreateVersion was a separate code path that wrote
// .versions/{id}.json files without touching the journal, so Load
// never saw those snapshots.

func TestLoadDocument_ReturnsLatestVersionContent_AfterCreateVersion(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	// Seed file has the original baseline content.
	seedPath := filepath.Join(store.baseDir, "doc.md")
	if err := os.WriteFile(seedPath, []byte("# Seed"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Frontend's auto-snapshot path: CreateVersion with the post-edit
	// content (e.g. the result of accepting a Suggest-Mode change).
	if _, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content:  "# After Accept - 123",
		MimeType: "text/markdown",
		Type:     "auto",
		Creator:  "user-1",
	}); err != nil {
		t.Fatal(err)
	}

	// Reload (e.g. user refreshes the page, relay restarts and fetches
	// content from the provider).
	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# After Accept - 123" {
		t.Errorf("LoadDocument should return latest version content; want %q, got %q",
			"# After Accept - 123", resp.Content)
	}
}

func TestLoadDocument_ReturnsLatestOfMultipleVersions(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	seedPath := filepath.Join(store.baseDir, "doc.md")
	if err := os.WriteFile(seedPath, []byte("# Seed"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Three sequential auto-snapshots, each with newer content. Use
	// an explicit pause between calls so the on-disk timestamps are
	// monotonically distinct on filesystems with second-level mtime
	// resolution.
	if _, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "# v1", Creator: "u",
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	if _, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "# v2", Creator: "u",
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	if _, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "# v3 latest", Creator: "u",
	}); err != nil {
		t.Fatal(err)
	}

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# v3 latest" {
		t.Errorf("LoadDocument should return the most recent version; want %q, got %q",
			"# v3 latest", resp.Content)
	}
}

func TestLoadDocument_NoVersions_FallsBackToSeed(t *testing.T) {
	store := newTestStore(t)
	seedPath := filepath.Join(store.baseDir, "doc.md")
	if err := os.WriteFile(seedPath, []byte("# Seed only"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Seed only" {
		t.Errorf("with no versions, want seed; got %q", resp.Content)
	}
}

func TestLoadDocument_StoreJournalStillTakesPrecedence(t *testing.T) {
	// Backward-compat: deployments that had Store() running pre-fix
	// rely on the .yjs journal pointer. If both a journal entry AND
	// CreateVersion entries exist, the journal MUST still be honored
	// (Store always reflects the most current relay state).
	store := newTestStore(t)
	ctx := context.Background()

	seedPath := filepath.Join(store.baseDir, "doc.md")
	if err := os.WriteFile(seedPath, []byte("# Seed"), 0o644); err != nil {
		t.Fatal(err)
	}

	// CreateVersion first (older formal version).
	if _, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "# Older formal version", Creator: "u",
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	// Then Store() — represents the latest relay flush.
	if _, err := store.Store(ctx, "doc.md", &spi.StoreRequest{
		Content:  "# Newest from Store",
		MimeType: "text/markdown",
	}); err != nil {
		t.Fatal(err)
	}

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Newest from Store" {
		t.Errorf("Store() journal should win when newer; want %q, got %q",
			"# Newest from Store", resp.Content)
	}
}

func TestLoadDocument_CreateVersionAfterStore_StoreStillWins(t *testing.T) {
	// Symmetric edge case: Store() ran first, then CreateVersion ran
	// later. The auto-version path should NOT mask the live relay
	// state — the most recent write wins. (Implementation: tie-break
	// by mtime; both paths use the local clock.)
	store := newTestStore(t)
	ctx := context.Background()

	seedPath := filepath.Join(store.baseDir, "doc.md")
	if err := os.WriteFile(seedPath, []byte("# Seed"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Store(ctx, "doc.md", &spi.StoreRequest{
		Content:  "# Older from Store",
		MimeType: "text/markdown",
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	if _, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "# Newer from CreateVersion", Creator: "u",
	}); err != nil {
		t.Fatal(err)
	}

	resp, err := store.LoadDocument("doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Newer from CreateVersion" {
		t.Errorf("most recent write should win; want %q, got %q",
			"# Newer from CreateVersion", resp.Content)
	}
}
