package relay

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestRedis(t *testing.T) (*miniredis.Miniredis, redis.UniversalClient) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { client.Close() })
	return mr, client
}

func TestRedisBroker_PublishSubscribe(t *testing.T) {
	_, rdb := newTestRedis(t)

	broker1 := NewRedisBroker(rdb)
	broker2 := NewRedisBroker(rdb)

	// Subscribe broker2 to a document
	ctx := context.Background()
	ch, cancel, err := broker2.Subscribe(ctx, "doc1")
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	// Brief pause for subscription to register
	time.Sleep(50 * time.Millisecond)

	// Publish from broker1
	err = broker1.Publish(ctx, "doc1", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}

	// broker2 should receive it
	select {
	case msg := <-ch:
		if string(msg) != "hello" {
			t.Errorf("got %q, want %q", msg, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for message")
	}
}

func TestRedisBroker_SelfEchoFiltered(t *testing.T) {
	_, rdb := newTestRedis(t)

	broker := NewRedisBroker(rdb)

	ctx := context.Background()
	ch, cancel, err := broker.Subscribe(ctx, "doc1")
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	time.Sleep(50 * time.Millisecond)

	// Publish from the same broker — should be filtered
	broker.Publish(ctx, "doc1", []byte("self"))

	select {
	case msg := <-ch:
		t.Errorf("should not receive self-echo, got %q", msg)
	case <-time.After(200 * time.Millisecond):
		// Expected: no message received
	}
}

func TestRedisBroker_MultiChannel(t *testing.T) {
	_, rdb := newTestRedis(t)

	broker1 := NewRedisBroker(rdb)
	broker2 := NewRedisBroker(rdb)

	ctx := context.Background()

	// Subscribe to doc1 only
	ch1, cancel1, _ := broker2.Subscribe(ctx, "doc1")
	defer cancel1()

	time.Sleep(50 * time.Millisecond)

	// Publish to doc2 — should NOT arrive on doc1 subscription
	broker1.Publish(ctx, "doc2", []byte("wrong-doc"))

	select {
	case msg := <-ch1:
		t.Errorf("doc1 subscription received doc2 message: %q", msg)
	case <-time.After(200 * time.Millisecond):
		// Expected
	}

	// Publish to doc1 — should arrive
	broker1.Publish(ctx, "doc1", []byte("right-doc"))

	select {
	case msg := <-ch1:
		if string(msg) != "right-doc" {
			t.Errorf("got %q, want %q", msg, "right-doc")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestRedisBroker_CancelUnsubscribes(t *testing.T) {
	_, rdb := newTestRedis(t)

	broker := NewRedisBroker(rdb)

	ctx := context.Background()
	ch, cancel, _ := broker.Subscribe(ctx, "doc1")

	cancel()

	// Channel should be closed after cancel
	select {
	case _, ok := <-ch:
		if ok {
			t.Error("channel should be closed after cancel")
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for channel close")
	}
}

func TestNoopBroker(t *testing.T) {
	broker := NewNoopBroker()

	// Publish should not error
	err := broker.Publish(context.Background(), "doc1", []byte("test"))
	if err != nil {
		t.Fatal(err)
	}

	// Subscribe returns closed channel
	ch, cancel, err := broker.Subscribe(context.Background(), "doc1")
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	select {
	case _, ok := <-ch:
		if ok {
			t.Error("noop broker channel should be closed")
		}
	default:
		// Expected — channel is closed
	}

	// Close should not error
	if err := broker.Close(); err != nil {
		t.Fatal(err)
	}
}
