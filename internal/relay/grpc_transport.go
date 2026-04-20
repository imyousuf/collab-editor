package relay

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sync"

	relayapiv1 "github.com/imyousuf/collab-editor/pkg/relayapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// GRPCTransport implements Transport using gRPC bidirectional streaming.
type GRPCTransport struct {
	Addr     string
	Listener net.Listener // optional: if set, used instead of creating a new listener

	server *grpc.Server
}

func (t *GRPCTransport) Serve(ctx context.Context, handler ConnectionHandler) error {
	lis := t.Listener
	if lis == nil {
		var err error
		lis, err = net.Listen("tcp", t.Addr)
		if err != nil {
			return fmt.Errorf("grpc listen: %w", err)
		}
	}

	t.server = grpc.NewServer()
	relayapiv1.RegisterRelayServiceServer(t.server, &relayServer{handler: handler})

	go func() {
		<-ctx.Done()
		slog.Info("grpc transport shutting down")
		t.server.GracefulStop()
	}()

	slog.Info("grpc transport listening", "addr", lis.Addr().String())
	return t.server.Serve(lis)
}

// GracefulStop stops the gRPC server gracefully.
func (t *GRPCTransport) GracefulStop() {
	if t.server != nil {
		t.server.GracefulStop()
	}
}

// relayServer implements the gRPC RelayService.
type relayServer struct {
	relayapiv1.UnimplementedRelayServiceServer
	handler ConnectionHandler
}

func (s *relayServer) JoinRoom(stream relayapiv1.RelayService_JoinRoomServer) error {
	// First message must contain document_id
	firstMsg, err := stream.Recv()
	if err != nil {
		return err
	}

	documentID := firstMsg.GetDocumentId()
	if documentID == "" {
		return status.Error(codes.InvalidArgument, "first message must contain document_id")
	}

	conn := newGRPCConn(stream, firstMsg.GetPayload())
	return s.handler(stream.Context(), documentID, conn)
}

func (s *relayServer) Health(_ context.Context, _ *relayapiv1.HealthRequest) (*relayapiv1.HealthResponse, error) {
	return &relayapiv1.HealthResponse{Status: "ok"}, nil
}

// grpcConn adapts a gRPC bidirectional stream to the Conn interface.
type grpcConn struct {
	stream relayapiv1.RelayService_JoinRoomServer
	mu     sync.Mutex // protects stream.Send (gRPC streams are not send-safe)

	// If the first message also carried a payload, buffer it for the first ReadMessage call.
	firstPayload []byte
	firstRead    bool
}

func newGRPCConn(stream relayapiv1.RelayService_JoinRoomServer, firstPayload []byte) *grpcConn {
	return &grpcConn{
		stream:       stream,
		firstPayload: firstPayload,
	}
}

func (c *grpcConn) ReadMessage(_ context.Context) ([]byte, error) {
	// Return buffered first payload if the join message carried one
	if !c.firstRead && len(c.firstPayload) > 0 {
		c.firstRead = true
		return c.firstPayload, nil
	}
	c.firstRead = true

	msg, err := c.stream.Recv()
	if err != nil {
		return nil, err
	}
	return msg.GetPayload(), nil
}

func (c *grpcConn) WriteMessage(_ context.Context, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stream.Send(&relayapiv1.RoomMessage{Payload: data})
}

func (c *grpcConn) Close(_ int, _ string) error {
	// gRPC stream lifecycle is managed by the RPC handler returning.
	return nil
}
