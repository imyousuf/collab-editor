package relay

import (
	"context"
	"log/slog"
	"time"

	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

// Flusher handles persisting buffered updates to the storage provider.
type Flusher struct {
	client     *provider.Client
	breaker    *CircuitBreaker
	metrics    *Metrics
	maxRetries int
	backoff    time.Duration
	lock       FlushLock // optional: distributed lock for multi-instance
}

func NewFlusher(client *provider.Client, breaker *CircuitBreaker, metrics *Metrics, maxRetries int, backoff time.Duration) *Flusher {
	return &Flusher{
		client:     client,
		breaker:    breaker,
		metrics:    metrics,
		maxRetries: maxRetries,
		backoff:    backoff,
	}
}

// SetFlushLock sets an optional distributed lock for multi-instance coordination.
// When set, only one instance flushes per document at a time.
func (f *Flusher) SetFlushLock(lock FlushLock) {
	f.lock = lock
}

// Flush drains the buffer and persists updates to the provider.
// Returns any updates that could not be stored (for re-queuing).
func (f *Flusher) Flush(ctx context.Context, documentID string, buffer *UpdateBuffer) []BufferedUpdate {
	// If distributed lock is configured, acquire before draining
	if f.lock != nil {
		acquired, err := f.lock.Acquire(ctx, documentID, 10*time.Second)
		if err != nil {
			slog.Debug("flush lock acquire error", "doc", documentID, "err", err)
			return nil
		}
		if !acquired {
			return nil // Another instance will handle this document
		}
		defer f.lock.Release(ctx, documentID)
	}

	updates := buffer.Drain()
	if len(updates) == 0 {
		return nil
	}

	if !f.breaker.Allow() {
		slog.Debug("circuit breaker open, re-queuing updates", "doc", documentID, "count", len(updates))
		return updates
	}

	payloads := ToPayloads(updates)

	start := time.Now()
	failed := f.storeWithRetry(ctx, documentID, payloads)
	elapsed := time.Since(start).Milliseconds()
	f.metrics.FlushDurationMs.Observe(float64(elapsed))

	if failed == nil {
		f.breaker.RecordSuccess()
		return nil
	}

	// Map failed sequences back to buffered updates for re-queuing
	failedSeqs := make(map[uint64]bool)
	for _, fu := range failed {
		failedSeqs[fu.Sequence] = true
	}

	var requeue []BufferedUpdate
	for _, u := range updates {
		if failedSeqs[u.Sequence] {
			requeue = append(requeue, u)
		}
	}
	return requeue
}

func (f *Flusher) storeWithRetry(ctx context.Context, documentID string, payloads []spi.UpdatePayload) []spi.FailedUpdate {
	backoff := f.backoff

	for attempt := 0; attempt < f.maxRetries; attempt++ {
		storeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		resp, err := f.client.Store(storeCtx, documentID, payloads)
		cancel()

		if err != nil {
			slog.Warn("flush attempt failed", "doc", documentID, "attempt", attempt+1, "err", err)
			f.breaker.RecordFailure()
			f.metrics.FlushErrorsTotal.WithLabelValues("error").Inc()

			if attempt < f.maxRetries-1 {
				select {
				case <-ctx.Done():
					return allFailed(payloads)
				case <-time.After(backoff):
				}
				backoff *= 2
			}
			continue
		}

		// Full success
		if len(resp.Failed) == 0 {
			return nil
		}

		// Partial failure (207) — retry only the failed ones
		slog.Warn("partial flush failure", "doc", documentID, "stored", resp.Stored, "failed", len(resp.Failed))
		f.metrics.FlushErrorsTotal.WithLabelValues("207").Inc()

		failedSeqs := make(map[uint64]bool)
		for _, fu := range resp.Failed {
			failedSeqs[fu.Sequence] = true
		}

		var retryPayloads []spi.UpdatePayload
		for _, p := range payloads {
			if failedSeqs[p.Sequence] {
				retryPayloads = append(retryPayloads, p)
			}
		}
		payloads = retryPayloads

		if attempt < f.maxRetries-1 {
			select {
			case <-ctx.Done():
				return resp.Failed
			case <-time.After(backoff):
			}
			backoff *= 2
		} else {
			return resp.Failed
		}
	}

	return allFailed(payloads)
}

func allFailed(payloads []spi.UpdatePayload) []spi.FailedUpdate {
	failed := make([]spi.FailedUpdate, len(payloads))
	for i, p := range payloads {
		failed[i] = spi.FailedUpdate{
			Sequence: p.Sequence,
			Error:    "max retries exceeded",
		}
	}
	return failed
}
