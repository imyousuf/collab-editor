package spi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// testProvider implements Provider for testing.
type testProvider struct {
	loadResp  *LoadResponse
	loadErr   error
	storeResp *StoreResponse
	storeErr  error

	// Track calls
	lastStoreDocID  string
	lastStoreUpdates []UpdatePayload
}

func (p *testProvider) Load(_ context.Context, documentID string) (*LoadResponse, error) {
	return p.loadResp, p.loadErr
}

func (p *testProvider) Store(_ context.Context, documentID string, updates []UpdatePayload) (*StoreResponse, error) {
	p.lastStoreDocID = documentID
	p.lastStoreUpdates = updates
	return p.storeResp, p.storeErr
}

func (p *testProvider) Health(_ context.Context) (*HealthResponse, error) {
	return &HealthResponse{Status: "ok"}, nil
}

func TestHTTPHandler_Health(t *testing.T) {
	p := &testProvider{}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}

	var resp HealthResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "ok" {
		t.Errorf("status: got %q, want %q", resp.Status, "ok")
	}
}

func TestHTTPHandler_Load(t *testing.T) {
	p := &testProvider{
		loadResp: &LoadResponse{
			Content:  "# Hello",
			MimeType: "text/markdown",
			Updates: []UpdatePayload{
				{Sequence: 1, Data: "AQEHA3NvdXJjZQ=="},
			},
		},
	}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("POST", "/documents/load?path=welcome.md", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}

	var resp LoadResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Content != "# Hello" {
		t.Errorf("content: got %q", resp.Content)
	}
	if len(resp.Updates) != 1 {
		t.Errorf("updates: got %d, want 1", len(resp.Updates))
	}
}

func TestHTTPHandler_Load_MissingPath(t *testing.T) {
	handler := NewHTTPHandler(&testProvider{})

	req := httptest.NewRequest("POST", "/documents/load", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHTTPHandler_Store(t *testing.T) {
	p := &testProvider{
		storeResp: &StoreResponse{Stored: 2},
	}
	handler := NewHTTPHandler(p)

	body := `{"updates":[{"sequence":1,"data":"AQEHA3Nv","client_id":123},{"sequence":2,"data":"AQEHA3Nv","client_id":123}]}`
	req := httptest.NewRequest("POST", "/documents/updates?path=doc1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusAccepted)
	}
	if p.lastStoreDocID != "doc1" {
		t.Errorf("docID: got %q, want %q", p.lastStoreDocID, "doc1")
	}
	if len(p.lastStoreUpdates) != 2 {
		t.Errorf("updates: got %d, want 2", len(p.lastStoreUpdates))
	}
}

func TestHTTPHandler_Store_MissingPath(t *testing.T) {
	handler := NewHTTPHandler(&testProvider{storeResp: &StoreResponse{}})

	req := httptest.NewRequest("POST", "/documents/updates", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHTTPHandler_Store_InvalidBody(t *testing.T) {
	handler := NewHTTPHandler(&testProvider{storeResp: &StoreResponse{}})

	req := httptest.NewRequest("POST", "/documents/updates?path=doc1", strings.NewReader("not json"))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHTTPHandler_Store_PartialFailure(t *testing.T) {
	p := &testProvider{
		storeResp: &StoreResponse{
			Stored: 1,
			Failed: []FailedUpdate{{Sequence: 2, Error: "write error"}},
		},
	}
	handler := NewHTTPHandler(p)

	body := `{"updates":[{"sequence":1,"data":"AA=="},{"sequence":2,"data":"AQ=="}]}`
	req := httptest.NewRequest("POST", "/documents/updates?path=doc1", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusMultiStatus {
		t.Errorf("status: got %d, want %d (207)", w.Code, http.StatusMultiStatus)
	}
}

func TestProcessLoadRequest(t *testing.T) {
	p := &testProvider{
		loadResp: &LoadResponse{Content: "hello", MimeType: "text/plain"},
	}

	resp, err := ProcessLoadRequest(context.Background(), p, "doc1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "hello" {
		t.Errorf("content: got %q", resp.Content)
	}
}

func TestProcessStoreRequest(t *testing.T) {
	p := &testProvider{
		storeResp: &StoreResponse{Stored: 1},
	}

	body := `{"updates":[{"sequence":1,"data":"AA==","client_id":0}]}`
	resp, err := ProcessStoreRequest(context.Background(), p, "doc1", []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 1 {
		t.Errorf("stored: got %d", resp.Stored)
	}
	if p.lastStoreDocID != "doc1" {
		t.Errorf("docID: got %q", p.lastStoreDocID)
	}
}

func TestProcessStoreRequest_InvalidJSON(t *testing.T) {
	p := &testProvider{}
	_, err := ProcessStoreRequest(context.Background(), p, "doc1", []byte("bad"))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

// Test with optional interfaces

type testProviderWithDelete struct {
	testProvider
	deletedDoc string
}

func (p *testProviderWithDelete) Delete(_ context.Context, documentID string) error {
	p.deletedDoc = documentID
	return nil
}

func TestHTTPHandler_Delete(t *testing.T) {
	p := &testProviderWithDelete{}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("DELETE", "/documents?path=doc1", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}
	if p.deletedDoc != "doc1" {
		t.Errorf("deleted doc: got %q", p.deletedDoc)
	}
}

type testProviderWithList struct {
	testProvider
}

func (p *testProviderWithList) ListDocuments(_ context.Context) ([]DocumentListEntry, error) {
	return []DocumentListEntry{
		{Name: "doc1.md", MimeType: "text/markdown", Size: 100},
		{Name: "app.jsx", MimeType: "text/jsx", Size: 200},
	}, nil
}

func TestHTTPHandler_ListDocuments(t *testing.T) {
	p := &testProviderWithList{}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}

	body, _ := io.ReadAll(w.Body)
	var result map[string][]DocumentListEntry
	json.Unmarshal(body, &result)
	if len(result["documents"]) != 2 {
		t.Errorf("documents: got %d, want 2", len(result["documents"]))
	}
}
