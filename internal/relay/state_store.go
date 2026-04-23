package relay

import "context"

// StateStore is the durability layer for server-side Y.Doc state in
// multi-pod deployments. It gives a freshly-booted relay pod a way to
// rebuild a room's Y.Doc without depending on sibling pods being alive
// or on the storage provider retaining Y.js history (the storage SPI is
// intentionally Yjs-agnostic and only persists plain text).
//
// Two primitives, one invariant:
//
//   - AppendUpdate is called on every Update that mutates Room.ydoc. It
//     RPUSHes the update bytes onto an append-only per-room log.
//   - WriteSnapshot encodes the full current Y.Doc state and replaces
//     the snapshot, then trims the log up to the snapshot's offset.
//   - Read operations (ReadSnapshot + ReadLogTail) return enough bytes
//     for a cold-starting pod to reconstruct an equivalent Y.Doc.
//
// Invariant: a pod that does ReadSnapshot(), applies it, then
// ReadLogTail(logOffsetFromSnapshot), and applies each tail entry, ends
// up with a Y.Doc byte-equal to any other pod that followed the same
// sequence — because Yjs updates are idempotent and commutative under
// YATA. Cold-start divergence reduces to "did we miss any write?"; the
// MULTI-wrapped RPUSH + PUBLISH ensures we don't.
type StateStore interface {
	// AppendUpdate RPUSHes a Yjs Update byte slice onto the room's
	// durable log. Also publishes the update on the pub/sub channel so
	// live sibling pods apply it immediately. The RPUSH and PUBLISH are
	// wrapped in a MULTI so cold-starting pods reading the log after
	// subscribing cannot miss entries.
	AppendUpdate(ctx context.Context, documentID string, update []byte) error

	// ReadSnapshot returns the latest Y.Doc snapshot bytes plus the log
	// offset recorded when that snapshot was written. If no snapshot
	// exists (never-flushed room), returns (nil, 0, nil).
	ReadSnapshot(ctx context.Context, documentID string) (snapshot []byte, logOffset int64, err error)

	// ReadLogTail returns every log entry with offset >= fromOffset.
	// Pass the offset returned by ReadSnapshot so you don't re-apply
	// updates already folded into the snapshot.
	ReadLogTail(ctx context.Context, documentID string, fromOffset int64) (updates [][]byte, nextOffset int64, err error)

	// WriteSnapshot replaces the current snapshot atomically and trims
	// log entries that are now represented in the snapshot. Callers
	// MUST hold the room's distributed FlushLock so only one pod
	// writes per flush window.
	WriteSnapshot(ctx context.Context, documentID string, state []byte) error

	// Close releases any resources held by the store.
	Close() error
}

// noopStateStore is the fallback for single-pod deployments where Redis
// is unconfigured. All operations are no-ops; ReadSnapshot returns no
// snapshot so the bootstrap falls through to the storage provider's
// plain-text Load path.
type noopStateStore struct{}

// NewNoopStateStore returns a StateStore that persists nothing. Used when
// Redis is not configured.
func NewNoopStateStore() StateStore {
	return &noopStateStore{}
}

func (n *noopStateStore) AppendUpdate(_ context.Context, _ string, _ []byte) error {
	return nil
}

func (n *noopStateStore) ReadSnapshot(_ context.Context, _ string) ([]byte, int64, error) {
	return nil, 0, nil
}

func (n *noopStateStore) ReadLogTail(_ context.Context, _ string, _ int64) ([][]byte, int64, error) {
	return nil, 0, nil
}

func (n *noopStateStore) WriteSnapshot(_ context.Context, _ string, _ []byte) error {
	return nil
}

func (n *noopStateStore) Close() error { return nil }
