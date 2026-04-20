package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

const (
	instanceIDLen  = 16
	channelPrefix  = "collab:room:"
)

// RedisBroker implements MessageBroker using Redis pub/sub.
// Each message is prefixed with a 16-byte instance ID to filter self-echo.
type RedisBroker struct {
	client     redis.UniversalClient
	instanceID []byte
}

// NewRedisBroker creates a Redis-backed message broker.
func NewRedisBroker(client redis.UniversalClient) *RedisBroker {
	id := make([]byte, instanceIDLen)
	if _, err := rand.Read(id); err != nil {
		panic("failed to generate instance ID: " + err.Error())
	}
	return &RedisBroker{
		client:     client,
		instanceID: id,
	}
}

func (b *RedisBroker) Publish(ctx context.Context, documentID string, data []byte) error {
	// Prefix with instance ID so receivers can filter self-echo
	msg := make([]byte, instanceIDLen+len(data))
	copy(msg[:instanceIDLen], b.instanceID)
	copy(msg[instanceIDLen:], data)

	return b.client.Publish(ctx, channelPrefix+documentID, msg).Err()
}

func (b *RedisBroker) Subscribe(ctx context.Context, documentID string) (<-chan []byte, func(), error) {
	sub := b.client.Subscribe(ctx, channelPrefix+documentID)
	ch := make(chan []byte, 256)
	subCtx, subCancel := context.WithCancel(ctx)

	go func() {
		defer close(ch)
		msgCh := sub.Channel()
		for {
			select {
			case <-subCtx.Done():
				return
			case msg, ok := <-msgCh:
				if !ok {
					return
				}
				raw := []byte(msg.Payload)
				if len(raw) <= instanceIDLen {
					continue
				}

				// Filter self-echo: skip messages from this instance
				if string(raw[:instanceIDLen]) == string(b.instanceID) {
					continue
				}

				// Forward the payload (strip instance ID prefix)
				payload := raw[instanceIDLen:]
				select {
				case ch <- payload:
				default:
					slog.Warn("broker recv channel full, dropping message",
						"doc", documentID,
						"from", hex.EncodeToString(raw[:instanceIDLen]),
					)
				}
			}
		}
	}()

	cancel := func() {
		subCancel()
		sub.Unsubscribe(context.Background(), channelPrefix+documentID)
		sub.Close()
	}

	return ch, cancel, nil
}

func (b *RedisBroker) Close() error {
	return nil // Redis client lifecycle managed by caller
}
