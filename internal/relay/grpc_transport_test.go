package relay

import (
	"context"
	"net"
	"testing"
	"time"

	relayapiv1 "github.com/imyousuf/collab-editor/pkg/relayapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func TestGRPCTransport_JoinRoom(t *testing.T) {
	// Start a gRPC transport with a test handler
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	receivedDoc := make(chan string, 1)
	receivedMsg := make(chan []byte, 1)
	sentMsg := []byte{0x00, 0x02, 0x01, 0x02, 0x03}

	handler := func(ctx context.Context, documentID string, conn Conn) error {
		receivedDoc <- documentID

		// Read a message from the client
		data, err := conn.ReadMessage(ctx)
		if err != nil {
			return err
		}
		receivedMsg <- data

		// Send a message back
		return conn.WriteMessage(ctx, sentMsg)
	}

	transport := &GRPCTransport{Listener: lis}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		if err := transport.Serve(ctx, handler); err != nil {
			t.Logf("transport serve error: %v", err)
		}
	}()

	// Connect a gRPC client
	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	client := relayapiv1.NewRelayServiceClient(conn)
	stream, err := client.JoinRoom(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Send join message with document_id
	err = stream.Send(&relayapiv1.RoomMessage{
		DocumentId: "test-doc",
		Payload:    []byte{0x00, 0x00, 0x01},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Verify handler received the document ID
	select {
	case doc := <-receivedDoc:
		if doc != "test-doc" {
			t.Errorf("document_id: got %q, want %q", doc, "test-doc")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for document_id")
	}

	// Verify handler received the payload from the first message
	select {
	case msg := <-receivedMsg:
		if string(msg) != string([]byte{0x00, 0x00, 0x01}) {
			t.Errorf("first payload: got %v, want %v", msg, []byte{0x00, 0x00, 0x01})
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for first message")
	}

	// Receive the message sent back by the handler
	resp, err := stream.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(resp.GetPayload()) != string(sentMsg) {
		t.Errorf("response payload: got %v, want %v", resp.GetPayload(), sentMsg)
	}

	cancel()
}

func TestGRPCTransport_JoinRoom_MissingDocumentID(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	handler := func(ctx context.Context, documentID string, conn Conn) error {
		t.Error("handler should not be called for missing document_id")
		return nil
	}

	transport := &GRPCTransport{Listener: lis}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		transport.Serve(ctx, handler)
	}()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	client := relayapiv1.NewRelayServiceClient(conn)
	stream, err := client.JoinRoom(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Send message without document_id
	err = stream.Send(&relayapiv1.RoomMessage{Payload: []byte{0x01}})
	if err != nil {
		t.Fatal(err)
	}

	// Should receive an error on Recv
	_, err = stream.Recv()
	if err == nil {
		t.Error("expected error for missing document_id")
	}

	cancel()
}

func TestGRPCTransport_Health(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	transport := &GRPCTransport{Listener: lis}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	handler := func(ctx context.Context, documentID string, conn Conn) error { return nil }

	go func() {
		transport.Serve(ctx, handler)
	}()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	client := relayapiv1.NewRelayServiceClient(conn)
	resp, err := client.Health(context.Background(), &relayapiv1.HealthRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetStatus() != "ok" {
		t.Errorf("health status: got %q, want %q", resp.GetStatus(), "ok")
	}

	cancel()
}

func TestGRPCConn_ReadWriteClose(t *testing.T) {
	// Test grpcConn with first payload buffering
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	firstPayload := []byte{0x00, 0x00, 0x01}
	secondPayload := []byte{0x00, 0x02, 0x03}
	readResults := make(chan []byte, 2)

	handler := func(ctx context.Context, documentID string, conn Conn) error {
		// First read should return the first payload (buffered from join message)
		data, err := conn.ReadMessage(ctx)
		if err != nil {
			return err
		}
		readResults <- data

		// Second read should come from the stream
		data, err = conn.ReadMessage(ctx)
		if err != nil {
			return err
		}
		readResults <- data

		// Close should not error
		return conn.Close(1000, "done")
	}

	transport := &GRPCTransport{Listener: lis}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		transport.Serve(ctx, handler)
	}()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	client := relayapiv1.NewRelayServiceClient(conn)
	stream, err := client.JoinRoom(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Send join + first payload
	stream.Send(&relayapiv1.RoomMessage{
		DocumentId: "test",
		Payload:    firstPayload,
	})

	// Send second message
	stream.Send(&relayapiv1.RoomMessage{
		Payload: secondPayload,
	})

	// Verify both reads
	select {
	case r := <-readResults:
		if string(r) != string(firstPayload) {
			t.Errorf("first read: got %v, want %v", r, firstPayload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout on first read")
	}

	select {
	case r := <-readResults:
		if string(r) != string(secondPayload) {
			t.Errorf("second read: got %v, want %v", r, secondPayload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout on second read")
	}

	cancel()
}
