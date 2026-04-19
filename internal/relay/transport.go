package relay

import "context"

// Conn abstracts a single bidirectional binary connection.
type Conn interface {
	ReadMessage(ctx context.Context) ([]byte, error)
	WriteMessage(ctx context.Context, data []byte) error
	Close(code int, reason string) error
}

// ConnectionHandler is called by Transport for each new connection.
type ConnectionHandler func(ctx context.Context, documentID string, conn Conn) error

// Transport abstracts how the relay accepts incoming connections.
// Implementations may host their own WebSocket server or adapt an external one.
type Transport interface {
	// Serve starts accepting connections. For each connection, it calls handler
	// with the document ID and connection. Blocks until ctx is cancelled.
	Serve(ctx context.Context, handler ConnectionHandler) error
}
