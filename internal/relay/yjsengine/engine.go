// Package yjsengine defines the per-document CRDT state interface used by
// the relay's wire-path code, and ships two implementations:
//
//   - YgoEngine: in-process, backed by reearth/ygo. Drop-in replacement
//     for the relay's previous direct *crdt.Doc usage. Kept for tests
//     and for bare-metal deployments without Node.
//
//   - SidecarEngine: out-of-process, backed by the canonical yjs npm
//     package running in a Node child (see cmd/yjs-engine). Used in
//     production to avoid the wire-format divergences we hit with ygo.
//
// All Engine methods are scoped to a docID; an Engine instance can host
// many documents simultaneously. Implementations are NOT safe for
// concurrent use within a single docID — callers (typically *relay.Room)
// must serialize. Different docIDs MAY be called concurrently.
package yjsengine

import (
	"context"
	"errors"
)

// Engine is the per-document CRDT state surface required by the relay.
// Implementations encapsulate either an in-process Y.Doc (ygo) or an
// out-of-process Y.Doc owned by a Node sidecar.
//
// Concurrency: callers must serialize all calls for a given docID.
// Calls for distinct docIDs may run in parallel.
type Engine interface {
	// Open prepares state for docID. Idempotent: re-opening an already
	// open doc returns nil and leaves existing state intact. Required
	// before any other op for that docID.
	Open(ctx context.Context, docID string) error

	// Close releases state for docID. Idempotent. After Close, further
	// calls for docID must be preceded by another Open.
	Close(ctx context.Context, docID string) error

	// BootstrapText seeds the named Y.Text with `content`. Idempotent:
	// if the Y.Text is non-empty it is a no-op. Used by the relay when
	// a fresh room is loaded from the storage provider's plain-text
	// content.
	BootstrapText(ctx context.Context, docID, name, content string) error

	// ApplyUpdate applies a Yjs V1 update payload to the doc. Used for
	// snapshot replay (cold-start), log-tail replay, and sidecar
	// reconnect catch-up. Idempotent: re-applying the same update is a
	// no-op (YATA dedupes by ID).
	ApplyUpdate(ctx context.Context, docID string, update []byte) error

	// SyncMessage processes one y-protocols/sync sub-frame body (the
	// bytes AFTER the y-websocket envelope byte). Returns:
	//   - msgType: the sync sub-type (SyncStep1/2/Update). Callers use
	//     this to decide whether to broadcast or just reply.
	//   - reply: optional response body to send back to the originating
	//     peer (non-nil for SyncStep1; nil for Update / SyncStep2).
	//     Callers prepend the y-websocket envelope byte before sending.
	//   - err: protocol error. Apply failure for an Update frame is
	//     wrapped as ErrApplyFailed and is non-fatal — the caller MAY
	//     still broadcast and buffer the raw frame.
	SyncMessage(ctx context.Context, docID string, syncBody []byte) (msgType byte, reply []byte, err error)

	// EncodeStateAsUpdate encodes the doc's full state as a Yjs V1
	// update. Used to write durable snapshots. May be a large byte
	// slice; callers should track a dirty flag and avoid calling this
	// on idle ticks.
	EncodeStateAsUpdate(ctx context.Context, docID string) ([]byte, error)

	// EncodeStateVector encodes the doc's state vector. Used by
	// catch-up flows that want to compute a missing-updates diff
	// without sending the full state. Mostly diagnostic; production
	// SyncStep1→SyncStep2 goes through SyncMessage.
	EncodeStateVector(ctx context.Context, docID string) ([]byte, error)

	// GetText returns the plain-text content of the named Y.Text.
	// Used by tests and operational diagnostics. The relay's wire path
	// doesn't depend on plain-text reads — those happen only at SPI
	// flush time, which is handled by the SDK side (pkg/spi) using its
	// own ygo engine.
	GetText(ctx context.Context, docID, name string) (string, error)
}

// Sync-message sub-types — y-protocols/sync's varuint header values
// the relay uses for routing decisions (broadcast vs. reply-only) and
// for filtering Update frames into the persistence buffer.
const (
	MsgSyncStep1 byte = 0
	MsgSyncStep2 byte = 1
	MsgUpdate    byte = 2
)

// Sentinel errors. Implementations wrap with %w so callers can use
// errors.Is.
var (
	// ErrUnknownDoc is returned when an op references a docID that is
	// not currently open.
	ErrUnknownDoc = errors.New("yjsengine: unknown doc")

	// ErrApplyFailed wraps a doc-apply failure in ApplyUpdate or in
	// the apply branch of SyncMessage. Callers may treat this as
	// non-fatal for Update frames (broadcast + buffer the raw bytes
	// anyway) and fatal for SyncStep1/2 frames (reply would be derived
	// from a stale doc).
	ErrApplyFailed = errors.New("yjsengine: apply failed")

	// ErrSidecarUnavailable is returned when a SidecarEngine call
	// cannot reach the Node sidecar. Callers should retry or fall
	// through to a recovery path. Never returned by YgoEngine.
	ErrSidecarUnavailable = errors.New("yjsengine: sidecar unavailable")
)
