package relay

import (
	"context"
	"testing"
	"time"
)

func TestRedisFlushLock_AcquireRelease(t *testing.T) {
	_, rdb := newTestRedis(t)

	lock := NewRedisFlushLock(rdb)
	ctx := context.Background()

	acquired, err := lock.Acquire(ctx, "doc1", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !acquired {
		t.Error("expected to acquire lock")
	}

	err = lock.Release(ctx, "doc1")
	if err != nil {
		t.Fatal(err)
	}
}

func TestRedisFlushLock_Contention(t *testing.T) {
	_, rdb := newTestRedis(t)

	lock1 := NewRedisFlushLock(rdb)
	lock2 := NewRedisFlushLock(rdb)
	ctx := context.Background()

	// lock1 acquires
	acquired, _ := lock1.Acquire(ctx, "doc1", 5*time.Second)
	if !acquired {
		t.Fatal("lock1 should acquire")
	}

	// lock2 should fail to acquire
	acquired, _ = lock2.Acquire(ctx, "doc1", 5*time.Second)
	if acquired {
		t.Error("lock2 should NOT acquire (held by lock1)")
	}

	// lock1 releases
	lock1.Release(ctx, "doc1")

	// lock2 should now succeed
	acquired, _ = lock2.Acquire(ctx, "doc1", 5*time.Second)
	if !acquired {
		t.Error("lock2 should acquire after lock1 released")
	}

	lock2.Release(ctx, "doc1")
}

func TestRedisFlushLock_OnlyOwnerCanRelease(t *testing.T) {
	_, rdb := newTestRedis(t)

	lock1 := NewRedisFlushLock(rdb)
	lock2 := NewRedisFlushLock(rdb)
	ctx := context.Background()

	// lock1 acquires
	lock1.Acquire(ctx, "doc1", 5*time.Second)

	// lock2 tries to release — should fail (not the owner)
	lock2.Release(ctx, "doc1")

	// lock1's lock should still be held
	acquired, _ := lock2.Acquire(ctx, "doc1", 5*time.Second)
	if acquired {
		t.Error("lock should still be held by lock1 after lock2's release attempt")
	}

	lock1.Release(ctx, "doc1")
}

func TestRedisFlushLock_TTLExpiry(t *testing.T) {
	mr, rdb := newTestRedis(t)

	lock := NewRedisFlushLock(rdb)
	ctx := context.Background()

	lock.Acquire(ctx, "doc1", 1*time.Second)

	// Fast-forward time in miniredis
	mr.FastForward(2 * time.Second)

	// Lock should have expired — another lock can acquire
	lock2 := NewRedisFlushLock(rdb)
	acquired, _ := lock2.Acquire(ctx, "doc1", 5*time.Second)
	if !acquired {
		t.Error("lock should have expired after TTL")
	}

	lock2.Release(ctx, "doc1")
}

func TestRedisFlushLock_DifferentDocuments(t *testing.T) {
	_, rdb := newTestRedis(t)

	lock := NewRedisFlushLock(rdb)
	ctx := context.Background()

	// Acquire for doc1
	acquired, _ := lock.Acquire(ctx, "doc1", 5*time.Second)
	if !acquired {
		t.Fatal("should acquire doc1")
	}

	// Should still be able to acquire doc2
	acquired, _ = lock.Acquire(ctx, "doc2", 5*time.Second)
	if !acquired {
		t.Error("should acquire doc2 independently")
	}

	lock.Release(ctx, "doc1")
	lock.Release(ctx, "doc2")
}

func TestLocalFlushLock(t *testing.T) {
	lock := NewLocalFlushLock()
	ctx := context.Background()

	acquired, err := lock.Acquire(ctx, "doc1", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !acquired {
		t.Error("local lock should always acquire")
	}

	err = lock.Release(ctx, "doc1")
	if err != nil {
		t.Fatal(err)
	}
}
