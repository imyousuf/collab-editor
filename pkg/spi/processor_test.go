package spi_test

import (
	"encoding/base64"
	"testing"

	"github.com/imyousuf/collab-editor/pkg/spi"
	"github.com/reearth/ygo/crdt"
)

// makeYWebSocketFrame wraps a raw Yjs update in a y-websocket sync-update frame.
// Format: [messageType=0] [syncType=2] [yjsUpdate...]
func makeYWebSocketFrame(yjsUpdate []byte) []byte {
	frame := make([]byte, 2+len(yjsUpdate))
	frame[0] = 0x00 // messageType: sync
	frame[1] = 0x02 // syncType: update
	copy(frame[2:], yjsUpdate)
	return frame
}

func TestProviderProcessor_ResolveStore(t *testing.T) {
	proc := spi.NewProviderProcessor(nil, spi.NewYgoEngine, "source")

	// Create a Y.Doc and insert text to generate a realistic Yjs update
	doc := crdt.New()
	text := doc.GetText("source")
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, "Hello World", nil)
	})
	yjsUpdate := doc.EncodeStateAsUpdate()

	// Wrap in y-websocket frame and base64 encode
	frame := makeYWebSocketFrame(yjsUpdate)
	b64 := base64.StdEncoding.EncodeToString(frame)

	req := &spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 1, Data: b64},
		},
	}

	proc.ResolveStore("test.md", req)

	if req.Content != "Hello World" {
		t.Fatalf("expected content %q, got %q", "Hello World", req.Content)
	}
	if req.MimeType != "text/markdown" {
		t.Fatalf("expected mime_type %q, got %q", "text/markdown", req.MimeType)
	}
}

func TestProviderProcessor_IncrementalUpdates(t *testing.T) {
	proc := spi.NewProviderProcessor(nil, spi.NewYgoEngine, "source")

	// First update: insert "Hello"
	doc := crdt.New()
	text := doc.GetText("source")
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, "Hello", nil)
	})
	update1 := doc.EncodeStateAsUpdate()

	req1 := &spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 1, Data: base64.StdEncoding.EncodeToString(makeYWebSocketFrame(update1))},
		},
	}
	proc.ResolveStore("doc.txt", req1)

	if req1.Content != "Hello" {
		t.Fatalf("after first store: expected %q, got %q", "Hello", req1.Content)
	}

	// Second update: append " World"
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 5, " World", nil)
	})
	// Encode diff using state vector
	sv := crdt.New()
	sv.ApplyUpdate(update1)
	diff := crdt.EncodeStateAsUpdateV1(doc, sv.StateVector())

	req2 := &spi.StoreRequest{
		Updates: []spi.UpdatePayload{
			{Sequence: 2, Data: base64.StdEncoding.EncodeToString(makeYWebSocketFrame(diff))},
		},
	}
	proc.ResolveStore("doc.txt", req2)

	if req2.Content != "Hello World" {
		t.Fatalf("after second store: expected %q, got %q", "Hello World", req2.Content)
	}
}

func TestProviderProcessor_EmptyUpdates(t *testing.T) {
	proc := spi.NewProviderProcessor(nil, spi.NewYgoEngine, "source")

	req := &spi.StoreRequest{
		Updates: []spi.UpdatePayload{},
	}
	proc.ResolveStore("doc.md", req)

	if req.Content != "" {
		t.Fatalf("expected empty content, got %q", req.Content)
	}
}
