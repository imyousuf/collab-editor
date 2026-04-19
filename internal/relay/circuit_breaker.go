package relay

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
)

type BreakerState int

const (
	BreakerClosed   BreakerState = iota // Normal operation
	BreakerOpen                         // Provider is down, skip flushes
	BreakerHalfOpen                     // Probing with one request
)

// CircuitBreaker monitors provider health and controls flush attempts.
type CircuitBreaker struct {
	mu           sync.RWMutex
	state        BreakerState
	failureCount int
	threshold    int
	lastCheck    time.Time
	interval     time.Duration
	client       *provider.Client
	metrics      *Metrics
}

func NewCircuitBreaker(client *provider.Client, threshold int, interval time.Duration, metrics *Metrics) *CircuitBreaker {
	return &CircuitBreaker{
		state:     BreakerClosed,
		threshold: threshold,
		interval:  interval,
		client:    client,
		metrics:   metrics,
	}
}

// Allow returns true if requests should be attempted.
func (cb *CircuitBreaker) Allow() bool {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	switch cb.state {
	case BreakerClosed:
		return true
	case BreakerHalfOpen:
		return true
	default: // BreakerOpen
		return false
	}
}

// RecordSuccess records a successful provider call.
func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failureCount = 0
	if cb.state != BreakerClosed {
		slog.Info("circuit breaker closing")
		cb.state = BreakerClosed
		cb.metrics.ProviderCircuitOpen.Set(0)
	}
}

// RecordFailure records a failed provider call.
func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failureCount++
	if cb.failureCount >= cb.threshold && cb.state == BreakerClosed {
		slog.Warn("circuit breaker opening", "failures", cb.failureCount)
		cb.state = BreakerOpen
		cb.metrics.ProviderCircuitOpen.Set(1)
	}
}

// State returns the current breaker state.
func (cb *CircuitBreaker) State() BreakerState {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

// StartHealthCheck begins periodic health checks in a goroutine.
func (cb *CircuitBreaker) StartHealthCheck(ctx context.Context) {
	ticker := time.NewTicker(cb.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cb.checkHealth(ctx)
		}
	}
}

func (cb *CircuitBreaker) checkHealth(ctx context.Context) {
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := cb.client.Health(checkCtx)
	if err != nil || resp.Status != "ok" {
		cb.RecordFailure()
		return
	}

	cb.mu.Lock()
	if cb.state == BreakerOpen {
		slog.Info("circuit breaker transitioning to half-open")
		cb.state = BreakerHalfOpen
	}
	cb.mu.Unlock()

	if cb.State() == BreakerHalfOpen {
		cb.RecordSuccess()
	}
}
