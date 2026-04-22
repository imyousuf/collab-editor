package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func TestLoad_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/documents/load" || r.URL.Query().Get("path") != "doc-1" {
			t.Errorf("unexpected request: %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(spi.LoadResponse{
			Content: "# Test Document",
		})
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	resp, err := c.Load(context.Background(), "doc-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "# Test Document" {
		t.Errorf("expected content, got %q", resp.Content)
	}
}

func TestLoad_NoContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	resp, err := c.Load(context.Background(), "new-doc", "")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "" || resp.MimeType != "" {
		t.Errorf("expected empty response for new doc")
	}
}

func TestLoad_Forbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	_, err := c.Load(context.Background(), "doc-1", "")
	if err != spi.ErrForbidden {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestStore_Accepted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(spi.StoreResponse{Stored: 2})
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	ts := time.Now().UTC()
	resp, err := c.Store(context.Background(), "doc-1", &spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 1, Data: "d1", ClientID: 100, CreatedAt: ts},
			{Sequence: 2, Data: "d2", ClientID: 200, CreatedAt: ts},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 2 {
		t.Errorf("stored: got %d, want 2", resp.Stored)
	}
}

func TestStore_PartialFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusMultiStatus)
		json.NewEncoder(w).Encode(spi.StoreResponse{
			Stored: 1,
			Failed: []spi.FailedUpdate{{Sequence: 2, Error: "storage_full"}},
		})
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	resp, err := c.Store(context.Background(), "doc-1", &spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 1, Data: "d1", CreatedAt: time.Now()},
			{Sequence: 2, Data: "d2", CreatedAt: time.Now()},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Stored != 1 || len(resp.Failed) != 1 {
		t.Errorf("expected partial failure: stored=%d, failed=%d", resp.Stored, len(resp.Failed))
	}
}

func TestHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(spi.HealthResponse{Status: "ok", Storage: "connected"})
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	resp, err := c.Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != "ok" {
		t.Errorf("health status: got %q", resp.Status)
	}
}

func TestLoad_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	_, err := c.Load(context.Background(), "doc-1", "")
	if err == nil {
		t.Error("expected error for 500 response")
	}
}

func TestLoad_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	c := NewClient(ClientConfig{BaseURL: srv.URL, StoreTimeout: 100 * time.Millisecond})
	_, err := c.Load(context.Background(), "doc-1", "")
	if err == nil {
		t.Error("expected timeout error")
	}
}
