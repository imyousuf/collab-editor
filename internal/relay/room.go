package relay

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Room represents a collaborative editing session for a single document.
type Room struct {
	mu           sync.RWMutex
	documentID   string
	peers        map[*Peer]struct{}
	buffer       *UpdateBuffer
	flusher      *Flusher
	flushMu      sync.Mutex // guards doFlush to prevent concurrent flushes
	flushTimer   *time.Timer
	config       RoomConfig
	metrics      *Metrics
	closeCh      chan struct{}
	closeOnce    sync.Once
}

func NewRoom(documentID string, cfg RoomConfig, flusher *Flusher, metrics *Metrics) *Room {
	return &Room{
		documentID: documentID,
		peers:      make(map[*Peer]struct{}),
		buffer:     NewUpdateBuffer(),
		flusher:    flusher,
		config:     cfg,
		metrics:    metrics,
		closeCh:    make(chan struct{}),
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
// Yjs messages: byte 0 = type (0=sync, 1=awareness)
func (r *Room) handleMessage(sender *Peer, data []byte) {
	if len(data) == 0 {
		return
	}

	// Relay the raw message to all other peers
	r.Broadcast(sender, data)
	r.metrics.UpdatesRelayedTotal.WithLabelValues(r.documentID).Inc()

	// Buffer the update for persistence (only sync update messages, type 0 subtype 2)
	if len(data) >= 2 && data[0] == 0 && data[1] == 2 {
		// This is a sync update message — buffer the Yjs update payload (bytes after the header)
		if len(data) > 2 {
			size := r.buffer.Append(data[2:], 0) // clientID 0 for now
			r.metrics.UpdatesBuffered.WithLabelValues(r.documentID).Set(float64(r.buffer.Len()))
			r.scheduleFlush(size)
		}
	}
}

// scheduleFlush sets up the debounced flush timer. If size exceeds threshold, flushes immediately.
func (r *Room) scheduleFlush(currentSize int) {
	if currentSize >= r.config.FlushMaxBytes {
		r.doFlush()
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.flushTimer != nil {
		r.flushTimer.Stop()
	}
	r.flushTimer = time.AfterFunc(r.config.FlushDebounce, func() {
		r.doFlush()
	})
}

// doFlush performs the actual flush to the provider.
// Protected by flushMu to prevent concurrent flushes.
func (r *Room) doFlush() {
	r.flushMu.Lock()
	defer r.flushMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	failed := r.flusher.Flush(ctx, r.documentID, r.buffer)
	if len(failed) > 0 {
		r.buffer.Prepend(failed)
		slog.Warn("re-queued failed updates", "doc", r.documentID, "count", len(failed))
	}
	r.metrics.UpdatesBuffered.WithLabelValues(r.documentID).Set(float64(r.buffer.Len()))
}

// Close performs final flush and cleanup when the room is being removed.
func (r *Room) Close() {
	r.closeOnce.Do(func() {
		close(r.closeCh)

		r.mu.Lock()
		if r.flushTimer != nil {
			r.flushTimer.Stop()
		}
		r.mu.Unlock()

		// Final flush (flushMu ensures no concurrent flush is in progress)
		r.doFlush()

		// Close all remaining peers
		r.mu.RLock()
		for p := range r.peers {
			p.Close()
		}
		r.mu.RUnlock()
	})
}
