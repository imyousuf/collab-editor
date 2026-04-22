package storagedemo

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

const testToken = "test-token"

func newTestServer(t *testing.T) (*httptest.Server, *FileStore) {
	t.Helper()
	store := newTestStore(t)
	handler := NewServer(store, nil, testToken)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, store
}

func doRequest(t *testing.T, srv *httptest.Server, method, path string, body any) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req, err := http.NewRequest(method, srv.URL+path, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestHealth(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("health status: got %d", resp.StatusCode)
	}
	var health spi.HealthResponse
	json.NewDecoder(resp.Body).Decode(&health)
	if health.Status != "ok" {
		t.Errorf("health: got %q", health.Status)
	}
}

func TestLoad_NewDocument(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := doRequest(t, srv, "POST", "/documents/load?path=new-doc.md", nil)
	defer resp.Body.Close()
	// SDK returns 200 with empty LoadResponse for non-existent documents
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
	var loadResp spi.LoadResponse
	json.NewDecoder(resp.Body).Decode(&loadResp)
	if loadResp.Content != "" {
		t.Errorf("expected empty content, got %q", loadResp.Content)
	}
}

func TestLoad_ExistingDocument(t *testing.T) {
	srv, store := newTestServer(t)

	// Write a file directly to simulate a seed document
	content := "# Test Document\n\nHello world."
	os.WriteFile(filepath.Join(store.baseDir, "test.md"), []byte(content), 0o644)

	resp := doRequest(t, srv, "POST", "/documents/load?path=test.md", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var loadResp spi.LoadResponse
	json.NewDecoder(resp.Body).Decode(&loadResp)
	if loadResp.Content != content {
		t.Errorf("expected content %q, got %q", content, loadResp.Content)
	}
}

func TestStoreUpdates_Success(t *testing.T) {
	srv, store := newTestServer(t)
	ts := time.Now().UTC()

	// Create a seed document first
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Seed"), 0o644)

	req := spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 1, Data: "AQID", ClientID: 100, CreatedAt: ts},
		},
	}

	resp := doRequest(t, srv, "POST", "/documents/updates?path=doc.md", req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", resp.StatusCode)
	}

	var storeResp spi.StoreResponse
	json.NewDecoder(resp.Body).Decode(&storeResp)
	if storeResp.Stored != 1 {
		t.Errorf("stored: got %d, want 1", storeResp.Stored)
	}

	// Verify updates are returned via load
	loadResp := doRequest(t, srv, "POST", "/documents/load?path=doc.md", nil)
	defer loadResp.Body.Close()
	var lr spi.LoadResponse
	json.NewDecoder(loadResp.Body).Decode(&lr)
	// After store, load returns the resolved content (not raw updates)
	if lr.Content == "" {
		t.Error("expected non-empty content after store")
	}
}

func TestStoreUpdates_EmptyBody(t *testing.T) {
	srv, _ := newTestServer(t)
	req := spi.StoreRequest{Updates: []spi.UpdatePayload{}}
	resp := doRequest(t, srv, "POST", "/documents/updates?path=doc.md", req)
	defer resp.Body.Close()
	// SDK passes empty slice to Store, which returns {stored: 0} with 202
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("expected 202, got %d", resp.StatusCode)
	}
	var storeResp spi.StoreResponse
	json.NewDecoder(resp.Body).Decode(&storeResp)
	if storeResp.Stored != 0 {
		t.Errorf("stored: got %d, want 0", storeResp.Stored)
	}
}

func TestListDocuments(t *testing.T) {
	srv, store := newTestServer(t)

	os.WriteFile(filepath.Join(store.baseDir, "welcome.md"), []byte("# Welcome"), 0o644)
	os.WriteFile(filepath.Join(store.baseDir, "page.html"), []byte("<h1>Page</h1>"), 0o644)
	os.WriteFile(filepath.Join(store.baseDir, "app.jsx"), []byte("export default function App() {}"), 0o644)

	req, _ := http.NewRequest("GET", srv.URL+"/documents", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result struct {
		Documents []spi.DocumentListEntry `json:"documents"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if len(result.Documents) != 3 {
		t.Fatalf("expected 3 documents, got %d", len(result.Documents))
	}

	// Verify MIME types are set correctly
	mimeByName := make(map[string]string)
	for _, d := range result.Documents {
		mimeByName[d.Name] = d.MimeType
	}
	if mimeByName["welcome.md"] != "text/markdown" {
		t.Errorf("welcome.md mime: got %q", mimeByName["welcome.md"])
	}
	if mimeByName["page.html"] != "text/html" {
		t.Errorf("page.html mime: got %q", mimeByName["page.html"])
	}
	if mimeByName["app.jsx"] != "text/jsx" {
		t.Errorf("app.jsx mime: got %q", mimeByName["app.jsx"])
	}
}

func TestLoad_IncludesMimeType(t *testing.T) {
	srv, store := newTestServer(t)
	os.WriteFile(filepath.Join(store.baseDir, "doc.md"), []byte("# Test"), 0o644)

	resp := doRequest(t, srv, "POST", "/documents/load?path=doc.md", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var loadResp spi.LoadResponse
	json.NewDecoder(resp.Body).Decode(&loadResp)
	if loadResp.MimeType != "text/markdown" {
		t.Errorf("expected mime_type text/markdown, got %q", loadResp.MimeType)
	}
}

func TestAuth_Unauthorized(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest("POST", srv.URL+"/documents/load?path=doc.md", nil)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 without auth, got %d", resp.StatusCode)
	}
}

func TestAuth_WrongToken(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest("POST", srv.URL+"/documents/load?path=doc.md", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong token, got %d", resp.StatusCode)
	}
}

func TestAuth_EmptyToken_AllowsRequests(t *testing.T) {
	// When auth token is empty, all requests should be allowed (open dev mode)
	store := newTestStore(t)
	handler := NewServer(store, nil, "") // empty token
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	// Request without any auth header should succeed
	resp, err := http.Get(srv.URL + "/documents")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 with empty token config, got %d", resp.StatusCode)
	}
}

func TestHealth_NoAuth(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("health should not require auth, got %d", resp.StatusCode)
	}
}

func TestDetectMimeType(t *testing.T) {
	tests := []struct {
		name     string
		expected string
	}{
		{"welcome.md", "text/markdown"},
		{"page.html", "text/html"},
		{"index.htm", "text/html"},
		{"script.py", "text/x-python"},
		{"app.jsx", "text/jsx"},
		{"main.js", "text/javascript"},
		{"component.tsx", "text/tsx"},
		{"main.ts", "text/typescript"},
		{"styles.css", "text/css"},
		{"config.json", "application/json"},
		{"data.xml", "application/xml"},
		{"config.yaml", "text/yaml"},
		{"config.yml", "text/yaml"},
		{"main.go", "text/x-go"},
		{"lib.rs", "text/x-rust"},
		{"App.java", "text/x-java"},
		{"readme.txt", "text/plain"},
		{"unknown.xyz", "text/plain"},
		{"noextension", "text/plain"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectMimeType(tt.name)
			if got != tt.expected {
				t.Errorf("detectMimeType(%q) = %q, want %q", tt.name, got, tt.expected)
			}
		})
	}
}
