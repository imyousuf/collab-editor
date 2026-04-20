package spi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

	if w.Code != http.StatusNoContent {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusNoContent)
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

// --- Version History tests ---

type testProviderWithVersions struct {
	testProvider
	versions        []VersionListEntry
	createdVersion  *VersionListEntry
	versionDetail   *VersionEntry
	lastCreateReq   *CreateVersionRequest
	lastGetDocID    string
	lastGetVersionID string
}

func (p *testProviderWithVersions) ListVersions(_ context.Context, documentID string) ([]VersionListEntry, error) {
	return p.versions, nil
}

func (p *testProviderWithVersions) CreateVersion(_ context.Context, documentID string, req *CreateVersionRequest) (*VersionListEntry, error) {
	p.lastCreateReq = req
	return p.createdVersion, nil
}

func (p *testProviderWithVersions) GetVersion(_ context.Context, documentID string, versionID string) (*VersionEntry, error) {
	p.lastGetDocID = documentID
	p.lastGetVersionID = versionID
	return p.versionDetail, nil
}

func TestHTTPHandler_ListVersions(t *testing.T) {
	ts := time.Now().UTC()
	p := &testProviderWithVersions{
		versions: []VersionListEntry{
			{ID: "v1", CreatedAt: ts, Type: "manual", Label: "first"},
			{ID: "v2", CreatedAt: ts, Type: "auto"},
		},
	}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/versions?path=doc1", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}

	body, _ := io.ReadAll(w.Body)
	var result map[string][]VersionListEntry
	json.Unmarshal(body, &result)
	if len(result["versions"]) != 2 {
		t.Errorf("versions: got %d, want 2", len(result["versions"]))
	}
}

func TestHTTPHandler_ListVersions_MissingPath(t *testing.T) {
	p := &testProviderWithVersions{}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/versions", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHTTPHandler_CreateVersion(t *testing.T) {
	ts := time.Now().UTC()
	p := &testProviderWithVersions{
		createdVersion: &VersionListEntry{ID: "v-new", CreatedAt: ts, Type: "manual", Label: "snapshot"},
	}
	handler := NewHTTPHandler(p)

	body := `{"content":"hello world","mime_type":"text/plain","label":"snapshot","creator":"alice","type":"manual"}`
	req := httptest.NewRequest("POST", "/documents/versions?path=doc1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusCreated)
	}
	if p.lastCreateReq == nil {
		t.Fatal("expected create request")
	}
	if p.lastCreateReq.Content != "hello world" {
		t.Errorf("content: got %q", p.lastCreateReq.Content)
	}
	if p.lastCreateReq.Label != "snapshot" {
		t.Errorf("label: got %q", p.lastCreateReq.Label)
	}
}

func TestHTTPHandler_GetVersion(t *testing.T) {
	p := &testProviderWithVersions{
		versionDetail: &VersionEntry{
			ID:      "v1",
			Content: "hello world",
			Blame: []BlameSegment{
				{Start: 0, End: 5, UserName: "alice"},
				{Start: 5, End: 11, UserName: "bob"},
			},
		},
	}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/versions/detail?path=doc1&version=v1", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}
	if p.lastGetDocID != "doc1" {
		t.Errorf("docID: got %q", p.lastGetDocID)
	}
	if p.lastGetVersionID != "v1" {
		t.Errorf("versionID: got %q", p.lastGetVersionID)
	}

	var resp VersionEntry
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Content != "hello world" {
		t.Errorf("content: got %q", resp.Content)
	}
	if len(resp.Blame) != 2 {
		t.Errorf("blame segments: got %d, want 2", len(resp.Blame))
	}
}

func TestHTTPHandler_GetVersion_NotFound(t *testing.T) {
	p := &testProviderWithVersions{versionDetail: nil}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/versions/detail?path=doc1&version=nonexistent", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestHTTPHandler_GetVersion_MissingVersion(t *testing.T) {
	p := &testProviderWithVersions{}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/versions/detail?path=doc1", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// --- Client Mappings tests ---

type testProviderWithClientMappings struct {
	testProvider
	mappings       []ClientUserMapping
	storedMappings []ClientUserMapping
}

func (p *testProviderWithClientMappings) GetClientMappings(_ context.Context, documentID string) ([]ClientUserMapping, error) {
	return p.mappings, nil
}

func (p *testProviderWithClientMappings) StoreClientMappings(_ context.Context, documentID string, mappings []ClientUserMapping) error {
	p.storedMappings = mappings
	return nil
}

func TestHTTPHandler_GetClientMappings(t *testing.T) {
	p := &testProviderWithClientMappings{
		mappings: []ClientUserMapping{
			{ClientID: 100, UserName: "alice"},
			{ClientID: 200, UserName: "bob"},
		},
	}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/clients?path=doc1", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}

	body, _ := io.ReadAll(w.Body)
	var result map[string][]ClientUserMapping
	json.Unmarshal(body, &result)
	if len(result["mappings"]) != 2 {
		t.Errorf("mappings: got %d, want 2", len(result["mappings"]))
	}
}

func TestHTTPHandler_StoreClientMappings(t *testing.T) {
	p := &testProviderWithClientMappings{}
	handler := NewHTTPHandler(p)

	body := `{"mappings":[{"client_id":100,"user_name":"alice"},{"client_id":200,"user_name":"bob"}]}`
	req := httptest.NewRequest("POST", "/documents/clients?path=doc1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusOK)
	}
	if len(p.storedMappings) != 2 {
		t.Errorf("stored mappings: got %d, want 2", len(p.storedMappings))
	}
	if p.storedMappings[0].UserName != "alice" {
		t.Errorf("first mapping: got %q", p.storedMappings[0].UserName)
	}
}

func TestHTTPHandler_GetClientMappings_MissingPath(t *testing.T) {
	p := &testProviderWithClientMappings{}
	handler := NewHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/clients", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", w.Code, http.StatusBadRequest)
	}
}
