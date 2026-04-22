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

// FlushResult contains the outcome of a flush operation.
type FlushResult struct {
	Requeue        []BufferedUpdate   // updates that need re-queuing
	VersionCreated *spi.VersionListEntry // version created during this flush (if any)
}

// Flush drains the buffer and persists updates to the provider.
func (f *Flusher) Flush(ctx context.Context, documentID string, buffer *UpdateBuffer) FlushResult {
	// If distributed lock is configured, acquire before draining
	if f.lock != nil {
		acquired, err := f.lock.Acquire(ctx, documentID, 10*time.Second)
		if err != nil {
			slog.Debug("flush lock acquire error", "doc", documentID, "err", err)
			return FlushResult{}
		}
		if !acquired {
			return FlushResult{} // Another instance will handle this document
		}
		defer f.lock.Release(ctx, documentID)
	}

	updates := buffer.Drain()
	if len(updates) == 0 {
		return FlushResult{}
	}

	if !f.breaker.Allow() {
		slog.Debug("circuit breaker open, re-queuing updates", "doc", documentID, "count", len(updates))
		return FlushResult{Requeue: updates}
	}

	payloads := ToPayloads(updates)

	start := time.Now()
	resp := f.storeWithRetry(ctx, documentID, payloads)
	elapsed := time.Since(start).Milliseconds()
	f.metrics.FlushDurationMs.Observe(float64(elapsed))

	if resp == nil {
		f.breaker.RecordSuccess()
		return FlushResult{}
	}

	if len(resp.Failed) == 0 {
		f.breaker.RecordSuccess()
		return FlushResult{VersionCreated: resp.VersionCreated}
	}

	// Map failed sequences back to buffered updates for re-queuing
	failedSeqs := make(map[uint64]bool)
	for _, fu := range resp.Failed {
		failedSeqs[fu.Sequence] = true
	}

	var requeue []BufferedUpdate
	for _, u := range updates {
		if failedSeqs[u.Sequence] {
			requeue = append(requeue, u)
		}
	}
	return FlushResult{Requeue: requeue, VersionCreated: resp.VersionCreated}
}

// storeWithRetry returns the final StoreResponse on success (possibly with Failed entries),
// or nil if all attempts failed with errors.
func (f *Flusher) storeWithRetry(ctx context.Context, documentID string, payloads []spi.UpdatePayload) *spi.StoreResponse {
	backoff := f.backoff

	for attempt := 0; attempt < f.maxRetries; attempt++ {
		storeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		req := &spi.StoreRequest{Updates: payloads}
		resp, err := f.client.Store(storeCtx, documentID, req)
		cancel()

		if err != nil {
			slog.Warn("flush attempt failed", "doc", documentID, "attempt", attempt+1, "err", err)
			f.breaker.RecordFailure()
			f.metrics.FlushErrorsTotal.WithLabelValues("error").Inc()

			if attempt < f.maxRetries-1 {
				select {
				case <-ctx.Done():
					return nil
				case <-time.After(backoff):
				}
				backoff *= 2
			}
			continue
		}

		// Full success or partial — return the response
		if len(resp.Failed) == 0 {
			return resp
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
				return resp
			case <-time.After(backoff):
			}
			backoff *= 2
		} else {
			return resp
		}
	}

	return nil
}
