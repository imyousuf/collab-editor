package relay

import (
	"context"
	"time"
)

// FlushLock provides distributed mutual exclusion for document flushing.
// Ensures only one instance flushes a given document at a time.
type FlushLock interface {
	// Acquire attempts to acquire the flush lock for a document.
	// Returns true if acquired, false if held by another instance.
	Acquire(ctx context.Context, documentID string, ttl time.Duration) (bool, error)

	// Release releases the flush lock for a document.
	Release(ctx context.Context, documentID string) error
}

// localFlushLock always acquires (single-instance, no contention).
type localFlushLock struct{}

// NewLocalFlushLock creates a lock that always succeeds (for single-instance mode).
func NewLocalFlushLock() FlushLock {
	return &localFlushLock{}
}

func (l *localFlushLock) Acquire(_ context.Context, _ string, _ time.Duration) (bool, error) {
	return true, nil
}

func (l *localFlushLock) Release(_ context.Context, _ string) error {
	return nil
}
