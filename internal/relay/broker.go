package relay

import "context"

// MessageBroker abstracts cross-instance message relay for multi-instance scaling.
// When a local peer sends a message, it's published via the broker.
// All instances subscribed to the same document receive and broadcast locally.
type MessageBroker interface {
	// Publish sends a message to all other instances subscribed to this document.
	Publish(ctx context.Context, documentID string, data []byte) error

	// Subscribe returns a channel of messages from other instances for this document.
	// The returned cancel function unsubscribes and closes the channel.
	Subscribe(ctx context.Context, documentID string) (msgs <-chan []byte, cancel func(), err error)

	// Close shuts down the broker.
	Close() error
}

// noopBroker is a single-instance broker that does nothing.
// Used when Redis is not configured.
type noopBroker struct{}

// NewNoopBroker creates a broker that doesn't relay messages cross-instance.
func NewNoopBroker() MessageBroker {
	return &noopBroker{}
}

func (b *noopBroker) Publish(_ context.Context, _ string, _ []byte) error {
	return nil
}

func (b *noopBroker) Subscribe(_ context.Context, _ string) (<-chan []byte, func(), error) {
	ch := make(chan []byte)
	close(ch)
	return ch, func() {}, nil
}

func (b *noopBroker) Close() error {
	return nil
}
