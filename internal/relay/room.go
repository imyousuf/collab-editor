package relay

import (
	"sync"
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
}

func NewRoom(documentID string, cfg RoomConfig, flusher *Flusher, metrics *Metrics) *Room {
	return &Room{
		documentID: documentID,
		peers:      make(map[*Peer]struct{}),
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
