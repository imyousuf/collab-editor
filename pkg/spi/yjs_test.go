package spi_test

import (
	"testing"

	"github.com/imyousuf/collab-editor/pkg/spi"
	"github.com/reearth/ygo/crdt"
)

// --- YDocEngine interface tests ---

func TestYDocEngine_InsertAndGetText(t *testing.T) {
	engine := spi.NewYgoEngine()
	engine.InsertText("source", "Hello World")

	got := engine.GetText("source")
	if got != "Hello World" {
		t.Fatalf("expected %q, got %q", "Hello World", got)
	}
}

func TestYDocEngine_RoundTripUpdate(t *testing.T) {
	engine1 := spi.NewYgoEngine()
	engine1.InsertText("source", "Hello World")

	update := engine1.EncodeStateAsUpdate()
	if len(update) == 0 {
		t.Fatal("encoded update is empty")
	}

	engine2 := spi.NewYgoEngine()
	if err := engine2.ApplyUpdate(update); err != nil {
		t.Fatalf("failed to apply update: %v", err)
	}

	got := engine2.GetText("source")
	if got != "Hello World" {
		t.Fatalf("expected %q, got %q", "Hello World", got)
	}
}

func TestYDocEngine_ApplyIncrementalUpdates(t *testing.T) {
	engine1 := spi.NewYgoEngine()
	engine1.InsertText("source", "Hello")

	// Get full state after first insert
	update1 := engine1.EncodeStateAsUpdate()

	// Apply to engine2 (simulates initial load)
	engine2 := spi.NewYgoEngine()
	if err := engine2.ApplyUpdate(update1); err != nil {
		t.Fatalf("failed to apply update1: %v", err)
	}
	if got := engine2.GetText("source"); got != "Hello" {
		t.Fatalf("after update1: expected %q, got %q", "Hello", got)
	}
}

func TestYDocEngine_MultipleTextTypes(t *testing.T) {
	engine := spi.NewYgoEngine()
	engine.InsertText("source", "Main content")
	engine.InsertText("notes", "Side notes")

	if got := engine.GetText("source"); got != "Main content" {
		t.Fatalf("source: expected %q, got %q", "Main content", got)
	}
	if got := engine.GetText("notes"); got != "Side notes" {
		t.Fatalf("notes: expected %q, got %q", "Side notes", got)
	}
}

func TestYDocEngine_EmptyDocReturnsEmptyText(t *testing.T) {
	engine := spi.NewYgoEngine()
	got := engine.GetText("source")
	if got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestYDocEngine_FactoryCreatesNewInstances(t *testing.T) {
	factory := spi.YDocEngineFactory(spi.NewYgoEngine)
	e1 := factory()
	e2 := factory()

	e1.InsertText("source", "doc1")
	e2.InsertText("source", "doc2")

	if e1.GetText("source") != "doc1" {
		t.Fatal("e1 should have doc1")
	}
	if e2.GetText("source") != "doc2" {
		t.Fatal("e2 should have doc2")
	}
}

// --- Direct ygo library tests (validates binary compatibility) ---

func TestYgoBasicTextOperations(t *testing.T) {
	doc := crdt.New()
	text := doc.GetText("source")

	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, "Hello World", nil)
	})

	got := text.ToString()
	if got != "Hello World" {
		t.Fatalf("expected %q, got %q", "Hello World", got)
	}
}

func TestYgoEncodeAndApplyUpdate(t *testing.T) {
	doc1 := crdt.New()
	text1 := doc1.GetText("source")

	doc1.Transact(func(txn *crdt.Transaction) {
		text1.Insert(txn, 0, "Hello World", nil)
	})

	update := doc1.EncodeStateAsUpdate()
	if len(update) == 0 {
		t.Fatal("encoded update is empty")
	}

	doc2 := crdt.New()
	if err := doc2.ApplyUpdate(update); err != nil {
		t.Fatalf("failed to apply update: %v", err)
	}

	got := doc2.GetText("source").ToString()
	if got != "Hello World" {
		t.Fatalf("expected %q, got %q", "Hello World", got)
	}
}

func TestYgoStateVectorDiffSync(t *testing.T) {
	doc1 := crdt.New()
	text1 := doc1.GetText("source")

	doc1.Transact(func(txn *crdt.Transaction) {
		text1.Insert(txn, 0, "Hello", nil)
	})

	doc2 := crdt.New()
	if err := doc2.ApplyUpdate(doc1.EncodeStateAsUpdate()); err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}

	doc1.Transact(func(txn *crdt.Transaction) {
		text1.Insert(txn, 5, " World", nil)
	})

	sv := doc2.StateVector()
	diffUpdate := crdt.EncodeStateAsUpdateV1(doc1, sv)

	if err := crdt.ApplyUpdateV1(doc2, diffUpdate, nil); err != nil {
		t.Fatalf("failed to apply diff: %v", err)
	}

	got := doc2.GetText("source").ToString()
	if got != "Hello World" {
		t.Fatalf("expected %q, got %q", "Hello World", got)
	}
}
