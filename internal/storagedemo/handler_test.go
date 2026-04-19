package storagedemo

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

const testToken = "test-token"

func newTestServer(t *testing.T) (*httptest.Server, *FileStore) {
	t.Helper()
	store := newTestStore(t)
	handler := NewServer(store, testToken)
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
	resp := doRequest(t, srv, "POST", "/documents/new-doc/load", spi.LoadRequest{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204, got %d", resp.StatusCode)
	}
}

func TestLoad_ExistingDocument(t *testing.T) {
	srv, store := newTestServer(t)
	ts := time.Now().UTC()
	store.StoreUpdates("doc-1", []spi.UpdatePayload{
		{Sequence: 1, Data: "dGVzdA==", ClientID: 100, CreatedAt: ts},
	})

	resp := doRequest(t, srv, "POST", "/documents/doc-1/load", spi.LoadRequest{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var loadResp spi.LoadResponse
	json.NewDecoder(resp.Body).Decode(&loadResp)
	if len(loadResp.Updates) != 1 {
		t.Errorf("expected 1 update, got %d", len(loadResp.Updates))
	}
}

func TestStoreUpdates_Success(t *testing.T) {
	srv, _ := newTestServer(t)
	ts := time.Now().UTC()

	req := spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 1, Data: "dGVzdA==", ClientID: 100, CreatedAt: ts},
			{Sequence: 2, Data: "dGVzdDI=", ClientID: 200, CreatedAt: ts},
		},
	}

	resp := doRequest(t, srv, "POST", "/documents/doc-1/updates", req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", resp.StatusCode)
	}

	var storeResp spi.StoreResponse
	json.NewDecoder(resp.Body).Decode(&storeResp)
	if storeResp.Stored != 2 {
		t.Errorf("stored: got %d, want 2", storeResp.Stored)
	}
}

func TestStoreUpdates_EmptyBody(t *testing.T) {
	srv, _ := newTestServer(t)
	req := spi.StoreRequest{Updates: []spi.UpdatePayload{}}
	resp := doRequest(t, srv, "POST", "/documents/doc-1/updates", req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestDeleteDocument_Handler(t *testing.T) {
	srv, store := newTestServer(t)
	ts := time.Now().UTC()
	store.StoreUpdates("doc-1", []spi.UpdatePayload{
		{Sequence: 1, Data: "data", ClientID: 100, CreatedAt: ts},
	})

	resp := doRequest(t, srv, "DELETE", "/documents/doc-1", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204, got %d", resp.StatusCode)
	}

	// Verify deleted
	loadResp := doRequest(t, srv, "POST", "/documents/doc-1/load", spi.LoadRequest{})
	defer loadResp.Body.Close()
	if loadResp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204 after delete, got %d", loadResp.StatusCode)
	}
}

func TestCompact_Handler(t *testing.T) {
	srv, store := newTestServer(t)
	ts := time.Now().UTC()
	store.StoreUpdates("doc-1", []spi.UpdatePayload{
		{Sequence: 1, Data: "d1", ClientID: 100, CreatedAt: ts},
		{Sequence: 2, Data: "d2", ClientID: 100, CreatedAt: ts},
	})

	req := spi.CompactRequest{
		Snapshot: spi.SnapshotPayload{
			Data:        "snap",
			StateVector: "sv",
			CreatedAt:   ts,
			UpdateCount: 2,
		},
		ReplaceSequencesUpTo: 2,
	}

	resp := doRequest(t, srv, "POST", "/documents/doc-1/compact", req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var compactResp spi.CompactResponse
	json.NewDecoder(resp.Body).Decode(&compactResp)
	if !compactResp.Compacted {
		t.Error("expected compacted=true")
	}
}

func TestAuth_Unauthorized(t *testing.T) {
	srv, _ := newTestServer(t)

	req, _ := http.NewRequest("POST", srv.URL+"/documents/doc-1/load", nil)
	req.Header.Set("Content-Type", "application/json")
	// No auth header
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

	req, _ := http.NewRequest("POST", srv.URL+"/documents/doc-1/load", nil)
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

func TestHealth_NoAuth(t *testing.T) {
	srv, _ := newTestServer(t)
	// Health endpoint should not require auth
	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("health should not require auth, got %d", resp.StatusCode)
	}
}
