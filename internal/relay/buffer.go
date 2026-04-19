package relay

import (
	"encoding/base64"
	"sync"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// BufferedUpdate holds a Yjs update pending flush to the provider.
type BufferedUpdate struct {
	Sequence  uint64
	Data      []byte
	ClientID  uint64
	CreatedAt time.Time
}

// UpdateBuffer is a thread-safe buffer for accumulating Yjs updates.
type UpdateBuffer struct {
	mu      sync.Mutex
	updates []BufferedUpdate
	size    int    // total bytes of update data
	seq     uint64 // monotonically increasing sequence counter
}

func NewUpdateBuffer() *UpdateBuffer {
	return &UpdateBuffer{}
}

// Append adds an update to the buffer and returns the current total size.
func (b *UpdateBuffer) Append(data []byte, clientID uint64) int {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.seq++
	b.updates = append(b.updates, BufferedUpdate{
		Sequence:  b.seq,
		Data:      data,
		ClientID:  clientID,
		CreatedAt: time.Now().UTC(),
	})
	b.size += len(data)
	return b.size
}

// Drain removes and returns all buffered updates atomically.
func (b *UpdateBuffer) Drain() []BufferedUpdate {
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.updates) == 0 {
		return nil
	}

	updates := b.updates
	b.updates = nil
	b.size = 0
	return updates
}

// Prepend re-inserts updates at the front (for re-queuing failed flushes).
func (b *UpdateBuffer) Prepend(updates []BufferedUpdate) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.updates = append(updates, b.updates...)
	for _, u := range updates {
		b.size += len(u.Data)
	}
}

// Len returns the number of buffered updates.
func (b *UpdateBuffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.updates)
}

// Size returns the total bytes of buffered update data.
func (b *UpdateBuffer) Size() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.size
}

// ToPayloads converts buffered updates to SPI update payloads.
func ToPayloads(updates []BufferedUpdate) []spi.UpdatePayload {
	payloads := make([]spi.UpdatePayload, len(updates))
	for i, u := range updates {
		payloads[i] = spi.UpdatePayload{
			Sequence:  u.Sequence,
			Data:      base64.StdEncoding.EncodeToString(u.Data),
			ClientID:  u.ClientID,
			CreatedAt: u.CreatedAt,
		}
	}
	return payloads
}
