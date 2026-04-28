package yjsengine

import (
	"context"
	"fmt"
	"sync"

	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

// serverClientID is the Yjs ClientID used for server-side seed inserts
// (BootstrapText). Pinned so two relay instances cold-starting the same
// room from the same provider content produce byte-identical seed
// updates that YATA dedupes as one operation. Clients use random 53-bit
// IDs and effectively never collide with this reserved value.
//
// Mirrors the constant in internal/relay/room.go (which will move here
// in C5 when Room is rewired).
const serverClientID crdt.ClientID = 1

// YgoEngine is an in-process Engine backed by reearth/ygo. One *crdt.Doc
// is held per docID. Drop-in replacement for the relay's previous direct
// ygo usage; mostly here so the existing test suite can run against the
// Engine interface without spawning a Node child.
//
// Not safe for concurrent use within a single docID. Callers (Room)
// must serialize via a per-doc mutex. Different docIDs may be accessed
// concurrently — the internal map is guarded by a separate mutex that
// only covers map mutations, not the docs themselves.
type YgoEngine struct {
	mu   sync.Mutex
	docs map[string]*crdt.Doc
}

// NewYgoEngine returns an empty YgoEngine. Docs are created lazily via
// Open.
func NewYgoEngine() *YgoEngine {
	return &YgoEngine{docs: make(map[string]*crdt.Doc)}
}

// Open creates an empty *crdt.Doc for docID if one doesn't already
// exist. Idempotent.
func (e *YgoEngine) Open(_ context.Context, docID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.docs[docID]; !ok {
		e.docs[docID] = crdt.New(crdt.WithClientID(serverClientID))
	}
	return nil
}

// Close discards the doc for docID. Idempotent.
func (e *YgoEngine) Close(_ context.Context, docID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.docs, docID)
	return nil
}

// BootstrapText seeds the named Y.Text with `content`. No-op if the
// text is already non-empty (i.e., another path already populated it).
func (e *YgoEngine) BootstrapText(_ context.Context, docID, name, content string) error {
	if content == "" {
		return nil
	}
	doc, err := e.lookup(docID)
	if err != nil {
		return err
	}
	text := doc.GetText(name)
	if text.Len() > 0 {
		return nil
	}
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, content, nil)
	})
	return nil
}

// ApplyUpdate applies a Yjs V1 update payload to the doc. Returns
// ErrApplyFailed (wrapping the underlying ygo error) on failure.
func (e *YgoEngine) ApplyUpdate(_ context.Context, docID string, update []byte) error {
	if len(update) == 0 {
		return nil
	}
	doc, err := e.lookup(docID)
	if err != nil {
		return err
	}
	if applyErr := doc.ApplyUpdate(update); applyErr != nil {
		return fmt.Errorf("%w: %v", ErrApplyFailed, applyErr)
	}
	return nil
}

// SyncMessage processes one sync sub-frame and returns the optional
// reply. Mirrors the call in room.go's handleSyncMessage but extracted
// behind the Engine interface.
func (e *YgoEngine) SyncMessage(_ context.Context, docID string, syncBody []byte) (byte, []byte, error) {
	doc, err := e.lookup(docID)
	if err != nil {
		return 0, nil, err
	}
	msgType, _, readErr := ysync.ReadSyncMessage(syncBody)
	if readErr != nil {
		return 0, nil, fmt.Errorf("yjsengine: invalid sync message: %w", readErr)
	}
	reply, applyErr := ysync.ApplySyncMessage(doc, syncBody, nil)
	if applyErr != nil {
		// Mirror room.go's policy: surface the failure with msgType
		// intact so the caller can distinguish Update (recoverable —
		// still broadcast the raw bytes) from SyncStep1/2 (fatal —
		// reply would be derived from a stale doc).
		return byte(msgType), nil, fmt.Errorf("%w: %v", ErrApplyFailed, applyErr)
	}
	return byte(msgType), reply, nil
}

// EncodeStateAsUpdate returns the doc's full state as a Yjs V1 update.
func (e *YgoEngine) EncodeStateAsUpdate(_ context.Context, docID string) ([]byte, error) {
	doc, err := e.lookup(docID)
	if err != nil {
		return nil, err
	}
	return doc.EncodeStateAsUpdate(), nil
}

// EncodeStateVector returns the doc's state vector.
func (e *YgoEngine) EncodeStateVector(_ context.Context, docID string) ([]byte, error) {
	doc, err := e.lookup(docID)
	if err != nil {
		return nil, err
	}
	return crdt.EncodeStateVectorV1(doc), nil
}

// GetText returns the plain-text content of the named Y.Text.
func (e *YgoEngine) GetText(_ context.Context, docID, name string) (string, error) {
	doc, err := e.lookup(docID)
	if err != nil {
		return "", err
	}
	return doc.GetText(name).ToString(), nil
}

// lookup resolves docID → *crdt.Doc with ErrUnknownDoc if not open.
// Holds the map mutex only for the duration of the lookup; doc-level
// safety is the caller's responsibility (see package docs).
func (e *YgoEngine) lookup(docID string) (*crdt.Doc, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	doc, ok := e.docs[docID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownDoc, docID)
	}
	return doc, nil
}
