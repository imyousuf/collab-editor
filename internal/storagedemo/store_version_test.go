package storagedemo

import (
	"context"
	"testing"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func TestCreateVersion(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	entry, err := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content:  "hello world",
		MimeType: "text/markdown",
		Label:    "initial",
		Creator:  "alice",
		Type:     "manual",
	})
	if err != nil {
		t.Fatal(err)
	}
	if entry == nil {
		t.Fatal("expected non-nil entry")
	}
	if entry.ID == "" {
		t.Error("expected non-empty ID")
	}
	if entry.Type != "manual" {
		t.Errorf("type: got %q", entry.Type)
	}
	if entry.Label != "initial" {
		t.Errorf("label: got %q", entry.Label)
	}
	if entry.Creator != "alice" {
		t.Errorf("creator: got %q", entry.Creator)
	}
}

func TestListVersions_Empty(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	versions, err := store.ListVersions(ctx, "doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 0 {
		t.Errorf("expected 0 versions, got %d", len(versions))
	}
}

func TestListVersions_Multiple(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "v1", Creator: "alice",
	})
	store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "v2", Creator: "bob",
	})

	versions, err := store.ListVersions(ctx, "doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 {
		t.Fatalf("expected 2 versions, got %d", len(versions))
	}

	// Newest first
	if versions[0].Creator != "bob" {
		t.Errorf("first version creator: got %q, want bob", versions[0].Creator)
	}
}

func TestGetVersion(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	created, _ := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content:  "hello world",
		MimeType: "text/markdown",
		Creator:  "alice",
		Blame: []spi.BlameSegment{
			{Start: 0, End: 11, UserName: "alice"},
		},
	})

	entry, err := store.GetVersion(ctx, "doc.md", created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if entry == nil {
		t.Fatal("expected non-nil entry")
	}
	if entry.Content != "hello world" {
		t.Errorf("content: got %q", entry.Content)
	}
	if len(entry.Blame) != 1 {
		t.Fatalf("blame segments: got %d, want 1", len(entry.Blame))
	}
	if entry.Blame[0].UserName != "alice" {
		t.Errorf("blame user: got %q", entry.Blame[0].UserName)
	}
}

func TestGetVersion_NotFound(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	entry, err := store.GetVersion(ctx, "doc.md", "nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	if entry != nil {
		t.Error("expected nil for nonexistent version")
	}
}

func TestStoreClientMappings(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	err := store.StoreClientMappings(ctx, "doc.md", []spi.ClientUserMapping{
		{ClientID: 100, UserName: "alice"},
		{ClientID: 200, UserName: "bob"},
	})
	if err != nil {
		t.Fatal(err)
	}

	mappings, err := store.GetClientMappings(ctx, "doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 2 {
		t.Fatalf("expected 2 mappings, got %d", len(mappings))
	}
}

func TestStoreClientMappings_Merge(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	store.StoreClientMappings(ctx, "doc.md", []spi.ClientUserMapping{
		{ClientID: 100, UserName: "alice"},
	})

	// Store with overlapping + new
	store.StoreClientMappings(ctx, "doc.md", []spi.ClientUserMapping{
		{ClientID: 100, UserName: "alice-updated"},
		{ClientID: 300, UserName: "charlie"},
	})

	mappings, err := store.GetClientMappings(ctx, "doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 2 {
		t.Fatalf("expected 2 mappings (merged), got %d", len(mappings))
	}

	byID := make(map[uint64]string)
	for _, m := range mappings {
		byID[m.ClientID] = m.UserName
	}
	if byID[100] != "alice-updated" {
		t.Errorf("client 100: got %q, want alice-updated", byID[100])
	}
	if byID[300] != "charlie" {
		t.Errorf("client 300: got %q, want charlie", byID[300])
	}
}

func TestGetClientMappings_Empty(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	mappings, err := store.GetClientMappings(ctx, "doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 0 {
		t.Errorf("expected 0 mappings, got %d", len(mappings))
	}
}

// Test HTTP handler integration for versions
func TestHTTPHandler_ListVersions(t *testing.T) {
	srv, store := newTestServer(t)
	ctx := context.Background()

	store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "hello", Creator: "alice",
	})

	resp := doRequest(t, srv, "GET", "/documents/versions?path=doc.md", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestHTTPHandler_CreateVersion(t *testing.T) {
	srv, _ := newTestServer(t)

	body := map[string]string{
		"content":   "hello world",
		"mime_type": "text/plain",
		"label":     "test",
		"creator":   "alice",
	}

	resp := doRequest(t, srv, "POST", "/documents/versions?path=doc.md", body)
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Errorf("expected 201, got %d", resp.StatusCode)
	}
}

func TestHTTPHandler_GetVersion(t *testing.T) {
	srv, store := newTestServer(t)
	ctx := context.Background()

	created, _ := store.CreateVersion(ctx, "doc.md", &spi.CreateVersionRequest{
		Content: "hello", Creator: "alice",
	})

	resp := doRequest(t, srv, "GET", "/documents/versions/detail?path=doc.md&version="+created.ID, nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestHTTPHandler_StoreClientMappings(t *testing.T) {
	srv, _ := newTestServer(t)

	body := map[string]any{
		"mappings": []map[string]any{
			{"client_id": 100, "user_name": "alice"},
		},
	}

	resp := doRequest(t, srv, "POST", "/documents/clients?path=doc.md", body)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestHTTPHandler_GetClientMappings(t *testing.T) {
	srv, store := newTestServer(t)
	ctx := context.Background()

	store.StoreClientMappings(ctx, "doc.md", []spi.ClientUserMapping{
		{ClientID: 100, UserName: "alice"},
	})

	resp := doRequest(t, srv, "GET", "/documents/clients?path=doc.md", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}
