package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

func newTestBreaker(t *testing.T, threshold int, healthStatus string) (*CircuitBreaker, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(spi.HealthResponse{Status: healthStatus})
	}))
	t.Cleanup(srv.Close)

	client := provider.NewClient(provider.ClientConfig{BaseURL: srv.URL, StoreTimeout: 5 * time.Second})
	metrics := NewMetrics()
	cb := NewCircuitBreaker(client, threshold, 100*time.Millisecond, metrics)
	return cb, srv
}

func TestCircuitBreaker_StartsOpen(t *testing.T) {
	cb, _ := newTestBreaker(t, 3, "ok")
	if cb.State() != BreakerClosed {
		t.Errorf("initial state: got %d, want closed", cb.State())
	}
	if !cb.Allow() {
		t.Error("should allow when closed")
	}
}

func TestCircuitBreaker_OpensAfterThreshold(t *testing.T) {
	cb, _ := newTestBreaker(t, 3, "ok")

	cb.RecordFailure()
	cb.RecordFailure()
	if cb.State() != BreakerClosed {
		t.Error("should still be closed after 2 failures")
	}

	cb.RecordFailure()
	if cb.State() != BreakerOpen {
		t.Errorf("should be open after 3 failures, got %d", cb.State())
	}
	if cb.Allow() {
		t.Error("should not allow when open")
	}
}

func TestCircuitBreaker_SuccessResetsClosed(t *testing.T) {
	cb, _ := newTestBreaker(t, 2, "ok")

	cb.RecordFailure()
	cb.RecordSuccess()
	if cb.State() != BreakerClosed {
		t.Error("success should keep closed")
	}

	// Failures should need to restart count
	cb.RecordFailure()
	if cb.State() != BreakerClosed {
		t.Error("single failure after reset should stay closed")
	}
}

func TestCircuitBreaker_HealthCheckRecovery(t *testing.T) {
	cb, _ := newTestBreaker(t, 1, "ok")

	// Trip the breaker
	cb.RecordFailure()
	if cb.State() != BreakerOpen {
		t.Fatal("expected open")
	}

	// Simulate health check
	cb.checkHealth(context.Background())

	// Should transition through half-open to closed
	if cb.State() != BreakerClosed {
		t.Errorf("expected closed after healthy check, got %d", cb.State())
	}
}
