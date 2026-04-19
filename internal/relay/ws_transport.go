package relay

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
)

// WSTransport is the built-in WebSocket transport using coder/websocket.
type WSTransport struct {
	Addr               string
	Listener           net.Listener // if set, used instead of Addr
	InsecureSkipVerify bool         // disable origin checks (dev only)
	ExtraRoutes        func(r chi.Router) // additional routes (e.g., /health)
}

func (t *WSTransport) Serve(ctx context.Context, handler ConnectionHandler) error {
	r := chi.NewRouter()

	if t.ExtraRoutes != nil {
		t.ExtraRoutes(r)
	}

	r.Get("/ws/{documentId}", func(w http.ResponseWriter, r *http.Request) {
		docID := chi.URLParam(r, "documentId")
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: t.InsecureSkipVerify,
		})
		if err != nil {
			slog.Error("websocket accept failed", "err", err)
			return
		}
		wc := &wsConn{conn: conn}
		if err := handler(r.Context(), docID, wc); err != nil {
			slog.Debug("connection handler finished", "doc", docID, "err", err)
		}
	})

	ln := t.Listener
	if ln == nil {
		var err error
		ln, err = net.Listen("tcp", t.Addr)
		if err != nil {
			return fmt.Errorf("ws transport listen: %w", err)
		}
	}

	srv := &http.Server{Handler: r}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()

	slog.Info("ws transport listening", "addr", ln.Addr())
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// wsConn wraps coder/websocket.Conn to implement the Conn interface.
type wsConn struct {
	conn *websocket.Conn
}

func (c *wsConn) ReadMessage(ctx context.Context) ([]byte, error) {
	_, data, err := c.conn.Read(ctx)
	return data, err
}

func (c *wsConn) WriteMessage(ctx context.Context, data []byte) error {
	return c.conn.Write(ctx, websocket.MessageBinary, data)
}

func (c *wsConn) Close(code int, reason string) error {
	return c.conn.Close(websocket.StatusCode(code), reason)
}
