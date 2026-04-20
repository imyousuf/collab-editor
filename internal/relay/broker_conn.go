package relay

import "context"

// brokerConn implements Conn for the broker peer pattern.
// ReadMessage reads from the Redis subscription channel (messages from other instances).
// WriteMessage publishes to Redis (messages from local peers broadcast to this broker peer).
type brokerConn struct {
	broker     MessageBroker
	documentID string
	recvCh     <-chan []byte
	cancelSub  func()
}

func newBrokerConn(broker MessageBroker, documentID string) (*brokerConn, error) {
	recvCh, cancel, err := broker.Subscribe(context.Background(), documentID)
	if err != nil {
		return nil, err
	}
	return &brokerConn{
		broker:     broker,
		documentID: documentID,
		recvCh:     recvCh,
		cancelSub:  cancel,
	}, nil
}

func (c *brokerConn) ReadMessage(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case data, ok := <-c.recvCh:
		if !ok {
			return nil, context.Canceled
		}
		return data, nil
	}
}

func (c *brokerConn) WriteMessage(ctx context.Context, data []byte) error {
	return c.broker.Publish(ctx, c.documentID, data)
}

func (c *brokerConn) Close(_ int, _ string) error {
	c.cancelSub()
	return nil
}
