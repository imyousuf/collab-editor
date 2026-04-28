package yjsengine_test

import (
	"context"
	"errors"
	"testing"

	"github.com/imyousuf/collab-editor/internal/relay/yjsengine"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

// engineFactory constructs a fresh Engine for one test. Each test gets
// its own engine to keep state isolated. C3 added the sidecar factory
// (see sidecar_client_test.go) which spawns a Node child per-test.
type engineFactory struct {
	name string
	make func(t *testing.T) yjsengine.Engine
}

// engineFactories holds the set of Engine implementations the contract
// tests run against. Modified in init() by sidecar_client_test.go to
// append the sidecar factory when its prerequisites are present.
var engineFactories = []engineFactory{
	{name: "ygo", make: func(*testing.T) yjsengine.Engine { return yjsengine.NewYgoEngine() }},
}

// addEngineFactory appends a factory. Called from init() in
// sidecar_client_test.go — keep this loose so future implementations
// can register themselves the same way.
func addEngineFactory(f engineFactory) {
	engineFactories = append(engineFactories, f)
}

func allEngines() []engineFactory { return engineFactories }

// runContract invokes test against every Engine implementation. Use
// t.Run subtests so each implementation reports its own pass/fail.
func runContract(t *testing.T, name string, test func(t *testing.T, e yjsengine.Engine)) {
	t.Helper()
	for _, f := range allEngines() {
		t.Run(f.name+"/"+name, func(t *testing.T) {
			test(t, f.make(t))
		})
	}
}

func TestOpen_Idempotent(t *testing.T) {
	runContract(t, "open_idempotent", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatalf("first Open: %v", err)
		}
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatalf("second Open: %v", err)
		}
	})
}

func TestOps_OnUnopenedDoc_ReturnUnknownDoc(t *testing.T) {
	runContract(t, "unknown_doc", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.ApplyUpdate(ctx, "missing", []byte{0x01}); !errors.Is(err, yjsengine.ErrUnknownDoc) {
			t.Errorf("ApplyUpdate err = %v, want ErrUnknownDoc", err)
		}
		if _, err := e.GetText(ctx, "missing", "source"); !errors.Is(err, yjsengine.ErrUnknownDoc) {
			t.Errorf("GetText err = %v, want ErrUnknownDoc", err)
		}
	})
}

func TestClose_Idempotent_DiscardsState(t *testing.T) {
	runContract(t, "close", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatal(err)
		}
		if err := e.BootstrapText(ctx, "doc-1", "source", "hello"); err != nil {
			t.Fatal(err)
		}
		if err := e.Close(ctx, "doc-1"); err != nil {
			t.Fatalf("first Close: %v", err)
		}
		if err := e.Close(ctx, "doc-1"); err != nil {
			t.Fatalf("second Close: %v", err)
		}
		// Doc should be gone — operations now return ErrUnknownDoc.
		if _, err := e.GetText(ctx, "doc-1", "source"); !errors.Is(err, yjsengine.ErrUnknownDoc) {
			t.Errorf("GetText after Close = %v, want ErrUnknownDoc", err)
		}
	})
}

func TestBootstrapText_SeedsAndIsIdempotent(t *testing.T) {
	runContract(t, "bootstrap", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatal(err)
		}
		if err := e.BootstrapText(ctx, "doc-1", "source", "hello world"); err != nil {
			t.Fatal(err)
		}
		got, err := e.GetText(ctx, "doc-1", "source")
		if err != nil {
			t.Fatal(err)
		}
		if got != "hello world" {
			t.Errorf("text after bootstrap = %q, want %q", got, "hello world")
		}
		// Second BootstrapText is a no-op (text already non-empty).
		if err := e.BootstrapText(ctx, "doc-1", "source", "ignored"); err != nil {
			t.Fatal(err)
		}
		got, _ = e.GetText(ctx, "doc-1", "source")
		if got != "hello world" {
			t.Errorf("text after second bootstrap = %q, want %q (idempotent)", got, "hello world")
		}
	})
}

// TestApplyUpdate_RoundTripsThroughEncodeState confirms that updates
// produced by EncodeStateAsUpdate can be replayed into a fresh doc and
// produce the same text. This is the core property used by snapshot
// recovery and sidecar reconnect.
func TestApplyUpdate_RoundTripsThroughEncodeState(t *testing.T) {
	runContract(t, "round_trip", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "src"); err != nil {
			t.Fatal(err)
		}
		if err := e.BootstrapText(ctx, "src", "source", "round trip me"); err != nil {
			t.Fatal(err)
		}
		state, err := e.EncodeStateAsUpdate(ctx, "src")
		if err != nil {
			t.Fatal(err)
		}
		if len(state) == 0 {
			t.Fatal("EncodeStateAsUpdate returned empty bytes")
		}

		if err := e.Open(ctx, "dst"); err != nil {
			t.Fatal(err)
		}
		if err := e.ApplyUpdate(ctx, "dst", state); err != nil {
			t.Fatal(err)
		}
		got, err := e.GetText(ctx, "dst", "source")
		if err != nil {
			t.Fatal(err)
		}
		if got != "round trip me" {
			t.Errorf("text after round-trip = %q, want %q", got, "round trip me")
		}
	})
}

// TestSyncMessage_Step1ProducesStep2 verifies the SyncStep1 →
// SyncStep2 flow: a peer sends its state vector, the engine returns
// the missing-updates payload, and applying that payload to a fresh
// peer produces the same content.
func TestSyncMessage_Step1ProducesStep2(t *testing.T) {
	runContract(t, "sync_step1_to_step2", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatal(err)
		}
		if err := e.BootstrapText(ctx, "doc-1", "source", "hello"); err != nil {
			t.Fatal(err)
		}

		// Build a SyncStep1 from a fresh peer doc (empty state vector).
		peer := crdt.New()
		step1 := ysync.EncodeSyncStep1(peer)

		msgType, reply, err := e.SyncMessage(ctx, "doc-1", step1)
		if err != nil {
			t.Fatalf("SyncMessage: %v", err)
		}
		if msgType != byte(ysync.MsgSyncStep1) {
			t.Errorf("msgType = %d, want MsgSyncStep1 (%d)", msgType, ysync.MsgSyncStep1)
		}
		if len(reply) == 0 {
			t.Fatal("expected non-empty SyncStep2 reply")
		}

		// Apply the reply to the peer doc; it should now have "hello".
		if _, err := ysync.ApplySyncMessage(peer, reply, nil); err != nil {
			t.Fatalf("apply reply on peer: %v", err)
		}
		if got := peer.GetText("source").ToString(); got != "hello" {
			t.Errorf("peer text after step2 = %q, want %q", got, "hello")
		}
	})
}

// TestSyncMessage_UpdateApplies verifies the relay can ingest a wire
// Update from a peer and reflect it in EncodeStateAsUpdate.
func TestSyncMessage_UpdateApplies(t *testing.T) {
	runContract(t, "sync_update", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatal(err)
		}

		// Construct a real Yjs update via a peer.
		peer := crdt.New()
		peerText := peer.GetText("source")
		peer.Transact(func(txn *crdt.Transaction) {
			peerText.Insert(txn, 0, "from peer", nil)
		})
		updateMsg := ysync.EncodeUpdate(peer.EncodeStateAsUpdate())

		msgType, reply, err := e.SyncMessage(ctx, "doc-1", updateMsg)
		if err != nil {
			t.Fatalf("SyncMessage update: %v", err)
		}
		if msgType != byte(ysync.MsgUpdate) {
			t.Errorf("msgType = %d, want MsgUpdate (%d)", msgType, ysync.MsgUpdate)
		}
		if len(reply) != 0 {
			t.Errorf("Update should produce no reply, got %d bytes", len(reply))
		}
		got, err := e.GetText(ctx, "doc-1", "source")
		if err != nil {
			t.Fatal(err)
		}
		if got != "from peer" {
			t.Errorf("text = %q, want %q", got, "from peer")
		}
	})
}

func TestEncodeStateVector_NonEmptyAfterBootstrap(t *testing.T) {
	runContract(t, "state_vector", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatal(err)
		}
		// Empty doc: state vector encoding is a single byte (varuint 0).
		emptySV, err := e.EncodeStateVector(ctx, "doc-1")
		if err != nil {
			t.Fatal(err)
		}
		if err := e.BootstrapText(ctx, "doc-1", "source", "x"); err != nil {
			t.Fatal(err)
		}
		nonEmptySV, err := e.EncodeStateVector(ctx, "doc-1")
		if err != nil {
			t.Fatal(err)
		}
		// Non-empty doc must have a non-empty SV (at least one client +
		// clock entry). Exact bytes are implementation-defined; just
		// assert change.
		if len(nonEmptySV) <= len(emptySV) {
			t.Errorf("SV after bootstrap (%d bytes) should exceed empty SV (%d bytes)", len(nonEmptySV), len(emptySV))
		}
	})
}

func TestApplyUpdate_EmptyIsNoop(t *testing.T) {
	runContract(t, "apply_empty", func(t *testing.T, e yjsengine.Engine) {
		ctx := context.Background()
		if err := e.Open(ctx, "doc-1"); err != nil {
			t.Fatal(err)
		}
		if err := e.ApplyUpdate(ctx, "doc-1", nil); err != nil {
			t.Errorf("ApplyUpdate(nil) = %v, want nil", err)
		}
		if err := e.ApplyUpdate(ctx, "doc-1", []byte{}); err != nil {
			t.Errorf("ApplyUpdate([]) = %v, want nil", err)
		}
	})
}
