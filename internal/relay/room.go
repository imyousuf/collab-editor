package relay

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// Room represents a collaborative editing session for a single document.
type Room struct {
	mu         sync.RWMutex
	documentID string
	peers      map[*Peer]struct{}
	config     RoomConfig
	metrics    *Metrics
	closeCh    chan struct{}
	closeOnce  sync.Once

	// Persistence: buffer raw y-websocket messages for flushing to storage
	buffer  *UpdateBuffer
	flusher *Flusher
	flushCh chan struct{} // signaled when buffer exceeds FlushMaxBytes

	// Complete history of sync update messages — both loaded from storage
	// and received during this room's lifetime. Replayed to newly
	// connecting peers before their read loop starts.
	historyMu sync.RWMutex
	history   [][]byte
}

func NewRoom(documentID string, cfg RoomConfig, flusher *Flusher, metrics *Metrics) *Room {
	return &Room{
		documentID: documentID,
		peers:      make(map[*Peer]struct{}),
		config:     cfg,
		metrics:    metrics,
		closeCh:    make(chan struct{}),
		buffer:     NewUpdateBuffer(),
		flusher:    flusher,
		flushCh:    make(chan struct{}, 1),
	}
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
// y-websocket messages: byte 0 = type (0=sync, 1=awareness).
// Only sync messages are buffered for persistence.
func (r *Room) handleMessage(sender *Peer, data []byte) {
	if len(data) == 0 {
		return
	}

	// Relay the raw message to all other peers
	r.Broadcast(sender, data)
	r.metrics.UpdatesRelayedTotal.WithLabelValues(r.documentID).Inc()

	// Buffer only sync UPDATE messages (type=0x00, subtype=0x02) for persistence.
	// Skip sync step1/step2 (subtypes 0x00/0x01) — they're session-specific handshakes.
	// Skip awareness messages (type=0x01) — they're ephemeral.
	if len(data) >= 2 && data[0] == 0x00 && data[1] == 0x02 {
		// Append to in-memory history for replay to new peers
		cp := make([]byte, len(data))
		copy(cp, data)
		r.historyMu.Lock()
		r.history = append(r.history, cp)
		r.historyMu.Unlock()

		totalSize := r.buffer.Append(data, 0)
		if totalSize >= r.config.FlushMaxBytes {
			select {
			case r.flushCh <- struct{}{}:
			default: // already signaled
			}
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

// SetStoredMessages sets the initial messages loaded from the storage provider.
// These become the base of the room's history, which grows as new messages arrive.
func (r *Room) SetStoredMessages(msgs [][]byte) {
	r.historyMu.Lock()
	defer r.historyMu.Unlock()
	r.history = msgs
}

// SendHistory replays the complete message history to a peer.
// Includes both stored messages from provider and messages received during this session.
func (r *Room) SendHistory(peer *Peer) {
	r.historyMu.RLock()
	defer r.historyMu.RUnlock()
	for _, msg := range r.history {
		peer.Send(msg)
	}
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
