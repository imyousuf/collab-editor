package relay

import (
	"context"
	"log/slog"
	"sync"
)

// Peer represents a connected client in a room.
type Peer struct {
	conn    Conn
	room    *Room
	writeCh chan []byte
	done    chan struct{}
	once    sync.Once
}

func newPeer(conn Conn, room *Room) *Peer {
	return &Peer{
		conn:    conn,
		room:    room,
		writeCh: make(chan []byte, 256),
		done:    make(chan struct{}),
	}
}

// Send queues a message for delivery to the peer. Non-blocking; drops if full.
func (p *Peer) Send(data []byte) {
	select {
	case p.writeCh <- data:
	default:
		slog.Warn("peer write channel full, dropping message", "doc", p.room.documentID)
	}
}

// Close signals the peer to stop.
func (p *Peer) Close() {
	p.once.Do(func() {
		close(p.done)
	})
}

// writeLoop drains writeCh and sends messages over the connection.
func (p *Peer) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.done:
			return
		case msg := <-p.writeCh:
			if err := p.conn.WriteMessage(ctx, msg); err != nil {
				slog.Debug("peer write error", "err", err)
				return
			}
		}
	}
}

// readLoop reads messages from the connection and passes them to the room.
func (p *Peer) readLoop(ctx context.Context) {
	for {
		data, err := p.conn.ReadMessage(ctx)
		if err != nil {
			return
		}
		p.room.handleMessage(p, data)
	}
}
