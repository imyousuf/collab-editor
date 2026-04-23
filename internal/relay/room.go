package relay

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

// y-websocket message type envelope bytes (first byte of each frame).
const (
	msgTypeSync            byte = 0x00 // y-protocols sync message — payload is a ygo/sync frame
	msgTypeAwareness       byte = 0x01 // y-protocols awareness message — broadcast only
	msgTypeApplicationEvt  byte = 0x03 // custom application event (e.g., version-created) — broadcast only
)

// serverClientID is the Yjs ClientID the relay uses when it generates its
// own updates (specifically the synthetic insert it does when bootstrapping
// a room from plain-text content). Pinning this to a constant means two
// relay instances that cold-start the same room from the same provider
// content produce byte-identical seed updates; the YATA merge dedupes them
// as the same operation, so the broker peer relaying between instances
// cannot double-seed. Clients use random 53-bit client IDs and will
// effectively never collide with this reserved value.
const serverClientID crdt.ClientID = 1

// Y.Text field that the editor binds to. Kept in sync with the frontend's
// CollaborationProvider, which calls `ydoc.getText('source')`.
const sharedTextName = "source"

// Room represents a collaborative editing session for a single document.
type Room struct {
	mu         sync.RWMutex
	documentID string
	peers      map[*Peer]struct{}
	config     RoomConfig
	metrics    *Metrics
	closeCh    chan struct{}
	closeOnce  sync.Once

	// Server-side Y.Doc. This is the authoritative in-memory state for
	// the room; SyncStep1 responses and Update merges go through it. A
	// single mutex serializes all writes because ygo's *crdt.Doc is not
	// safe for concurrent mutation.
	ydoc   *crdt.Doc
	ydocMu sync.Mutex

	// Phase 2: durable event log for multi-pod cold-start. Every Update
	// applied to ydoc is also appended via stateStore.AppendUpdate.
	// Nil when Redis isn't configured (single-pod mode); behaves as a
	// noop in that case.
	stateStore StateStore

	// Persistence: buffer raw y-websocket messages for flushing to storage
	buffer  *UpdateBuffer
	flusher *Flusher
	flushCh chan struct{} // signaled when buffer exceeds FlushMaxBytes
}

func NewRoom(documentID string, cfg RoomConfig, flusher *Flusher, metrics *Metrics) *Room {
	return &Room{
		documentID: documentID,
		peers:      make(map[*Peer]struct{}),
		config:     cfg,
		metrics:    metrics,
		closeCh:    make(chan struct{}),
		ydoc:       crdt.New(crdt.WithClientID(serverClientID)),
		stateStore: NewNoopStateStore(),
		buffer:     NewUpdateBuffer(),
		flusher:    flusher,
		flushCh:    make(chan struct{}, 1),
	}
}

// SetStateStore installs a StateStore for durable event log + snapshot
// operations. Called by Server wiring when Redis is configured; left as
// the noop default for single-pod deployments.
func (r *Room) SetStateStore(store StateStore) {
	if store == nil {
		store = NewNoopStateStore()
	}
	r.stateStore = store
}

// BootstrapContent seeds the room's Y.Doc with plain text returned from
// the storage provider. Must be called before any peer starts syncing.
// Idempotent: if the Y.Doc already has content (e.g., a sibling relay
// instance beat us to it via Redis event log), this is a no-op.
func (r *Room) BootstrapContent(content string) {
	if content == "" {
		return
	}
	r.ydocMu.Lock()
	defer r.ydocMu.Unlock()
	text := r.ydoc.GetText(sharedTextName)
	if text.Len() > 0 {
		return
	}
	r.ydoc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, content, nil)
	})
}

// BootstrapFromSnapshot applies a Yjs-encoded state to the room's
// Y.Doc. Used during Phase-2 cold-start: a fresh pod reads a snapshot
// from the StateStore and replays the log tail on top, arriving at the
// same state its sibling pods hold in memory. No-op on empty input or
// if the Y.Doc already has content.
func (r *Room) BootstrapFromSnapshot(state []byte) error {
	if len(state) == 0 {
		return nil
	}
	r.ydocMu.Lock()
	defer r.ydocMu.Unlock()
	if r.ydoc.GetText(sharedTextName).Len() > 0 {
		return nil
	}
	return r.ydoc.ApplyUpdate(state)
}

// ApplyLogEntry applies a single Yjs Update (a log-tail entry) to the
// room's Y.Doc. Used during Phase-2 cold-start after a snapshot apply.
// YATA guarantees idempotency — re-applying an entry already folded
// into the snapshot is safe.
func (r *Room) ApplyLogEntry(update []byte) error {
	if len(update) == 0 {
		return nil
	}
	r.ydocMu.Lock()
	defer r.ydocMu.Unlock()
	return r.ydoc.ApplyUpdate(update)
}

// YDocState returns the current Y.Doc state encoded as a Yjs V1 update,
// suitable for persistence or for bootstrapping another relay instance.
func (r *Room) YDocState() []byte {
	r.ydocMu.Lock()
	defer r.ydocMu.Unlock()
	return r.ydoc.EncodeStateAsUpdate()
}

// AddPeer adds a peer to the room.
func (r *Room) AddPeer(p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.peers[p] = struct{}{}
	r.metrics.PeersConnected.Inc()
}

// RemovePeer removes a peer from the room. Returns true if the room is now empty.
func (r *Room) RemovePeer(p *Peer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, p)
	r.metrics.PeersConnected.Dec()
	return len(r.peers) == 0
}

// PeerCount returns the number of connected peers.
func (r *Room) PeerCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers)
}

// Broadcast sends a message to all peers except the sender.
func (r *Room) Broadcast(sender *Peer, data []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for p := range r.peers {
		if p != sender {
			p.Send(data)
		}
	}
}

// BroadcastAll sends a message to all peers including the sender.
func (r *Room) BroadcastAll(data []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for p := range r.peers {
		p.Send(data)
	}
}

// handleMessage processes an incoming binary message from a peer.
//
// y-websocket message framing: byte 0 is the message type envelope
// (0x00 = sync, 0x01 = awareness, 0x03 = application event). The rest
// is the payload for that type.
//
// Sync messages are handled by the ygo sync protocol (SyncStep1 gets a
// SyncStep2 reply drawn from r.ydoc; SyncStep2 and Update are applied
// to r.ydoc; Updates are broadcast + buffered for persistence).
// Awareness and application events are broadcast unchanged.
func (r *Room) handleMessage(sender *Peer, data []byte) {
	if len(data) == 0 {
		return
	}

	switch data[0] {
	case msgTypeSync:
		r.handleSyncMessage(sender, data)
	case msgTypeAwareness, msgTypeApplicationEvt:
		r.Broadcast(sender, data)
		r.metrics.UpdatesRelayedTotal.WithLabelValues(r.documentID).Inc()
	default:
		// Unknown frame type — broadcast as-is so future protocol
		// extensions keep working, but don't attempt to interpret.
		r.Broadcast(sender, data)
	}
}

// handleSyncMessage processes a sync-framed message (byte 0 == 0x00).
//
// We delegate the heavy lifting to ygo/sync.ApplySyncMessage, which:
//   - for SyncStep1: reads the peer's state vector, returns a SyncStep2
//     body containing the updates the peer is missing.
//   - for SyncStep2: applies the included state (e.g., during catch-up).
//   - for Update: applies the update.
//
// Reply (if any) is framed with the sync envelope byte and sent to the
// originating peer ONLY. Updates are additionally broadcast to the other
// peers and buffered for the flush-to-provider path.
func (r *Room) handleSyncMessage(sender *Peer, frame []byte) {
	if len(frame) < 2 {
		return
	}
	syncMsg := frame[1:]

	msgType, _, readErr := ysync.ReadSyncMessage(syncMsg)
	if readErr != nil {
		slog.Warn("invalid sync message", "doc", r.documentID, "err", readErr)
		return
	}

	r.ydocMu.Lock()
	reply, applyErr := ysync.ApplySyncMessage(r.ydoc, syncMsg, nil)
	r.ydocMu.Unlock()
	if applyErr != nil {
		slog.Warn("sync apply failed", "doc", r.documentID, "type", msgType, "err", applyErr)
		return
	}

	if len(reply) > 0 {
		framed := make([]byte, 1+len(reply))
		framed[0] = msgTypeSync
		copy(framed[1:], reply)
		sender.Send(framed)
	}

	switch msgType {
	case ysync.MsgUpdate:
		// Live edit from a peer — fan out to everyone else, buffer for
		// persistence. SyncStep1/2 are session-specific and are NOT
		// broadcast; they only travel between the requesting peer and
		// the server.
		r.Broadcast(sender, frame)
		r.metrics.UpdatesRelayedTotal.WithLabelValues(r.documentID).Inc()

		totalSize := r.buffer.Append(frame, 0)
		if totalSize >= r.config.FlushMaxBytes {
			select {
			case r.flushCh <- struct{}{}:
			default: // already signaled
			}
		}

		// Phase 2: append the raw Yjs Update payload (not the wrapped
		// sync frame) to the durable event log. That way any pod
		// cold-starting the same room can rebuild the Y.Doc without
		// needing live pub/sub or sibling memory. We fire-and-forget
		// with a short timeout so a slow or flapping Redis can't block
		// the hot path — the room's in-memory Y.Doc is authoritative;
		// the log is the durability tail.
		if _, payload, err := ysync.ReadSyncMessage(frame[1:]); err == nil && len(payload) > 0 {
			appendCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			go func(update []byte) {
				defer cancel()
				if err := r.stateStore.AppendUpdate(appendCtx, r.documentID, update); err != nil {
					slog.Warn("state store append failed", "doc", r.documentID, "err", err)
				}
			}(payload)
		}
	}
}

// StartFlushLoop runs the periodic flush goroutine.
// Flushes buffered updates to the storage provider on a timer or when
// the buffer exceeds FlushMaxBytes. Performs a final flush on close.
//
// The loop is tied to the room's lifecycle (closeCh), NOT to any
// specific connection context. This ensures flushing continues even
// after the first peer disconnects and new peers join later.
func (r *Room) StartFlushLoop(storeTimeout time.Duration) {
	ticker := time.NewTicker(r.config.FlushDebounce)
	defer ticker.Stop()

	for {
		select {
		case <-r.closeCh:
			r.flushBuffer(storeTimeout)
			return
		case <-ticker.C:
			r.flushBuffer(storeTimeout)
		case <-r.flushCh:
			r.flushBuffer(storeTimeout)
		}
	}
}

func (r *Room) flushBuffer(storeTimeout time.Duration) {
	if r.flusher == nil || r.buffer.Len() == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
	defer cancel()
	result := r.flusher.Flush(ctx, r.documentID, r.buffer)
	if len(result.Requeue) > 0 {
		r.buffer.Prepend(result.Requeue)
		slog.Warn("re-queued failed updates", "doc", r.documentID, "count", len(result.Requeue))
	}

	// Broadcast version-created event to all peers
	if result.VersionCreated != nil {
		msg := encodeVersionCreatedMessage(result.VersionCreated)
		if msg != nil {
			r.BroadcastAll(msg)
		}
	}

	// Phase 2: piggyback snapshot compaction onto the flush tick.
	// Only the pod that won the Flusher's distributed lock (or ran a
	// local flush in single-pod mode) reaches this point, so snapshots
	// are written at most once per flush window across the cluster.
	// Snapshot replaces the Redis snapshot key and LTRIMs the log.
	state := r.YDocState()
	if len(state) > 0 {
		if err := r.stateStore.WriteSnapshot(ctx, r.documentID, state); err != nil {
			slog.Warn("state store write snapshot failed", "doc", r.documentID, "err", err)
		}
	}
}

// encodeVersionCreatedMessage encodes a version-created event as a custom
// binary message: [0x03, JSON payload].
// Message type 0x03 = application event (distinct from 0x00=sync, 0x01=awareness).
func encodeVersionCreatedMessage(entry *spi.VersionListEntry) []byte {
	payload, err := json.Marshal(map[string]any{
		"type":    "version-created",
		"version": entry,
	})
	if err != nil {
		return nil
	}
	msg := make([]byte, 1+len(payload))
	msg[0] = 0x03 // application event message type
	copy(msg[1:], payload)
	return msg
}

// Close cleans up the room when it's being removed.
func (r *Room) Close() {
	r.closeOnce.Do(func() {
		close(r.closeCh)

		r.mu.RLock()
		for p := range r.peers {
			p.Close()
		}
		r.mu.RUnlock()
	})
}
