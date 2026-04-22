package spi

import (
	"encoding/base64"
	"log/slog"
	"sync"

	ysync "github.com/reearth/ygo/sync"
)

// ProviderProcessor wraps a Provider and applies Y.js resolution.
// On Store: applies raw Y.js updates to a cached Y.Doc, extracts resolved
// text, and populates StoreRequest.Content before calling the provider.
// On Load: passes through to the provider (content is already resolved).
type ProviderProcessor struct {
	provider      Provider
	engineFactory YDocEngineFactory
	textKey       string // Y.Text shared type name (default: "source")

	mu    sync.Mutex
	cache map[string]YDocEngine // documentID → cached engine
}

// NewProviderProcessor creates a processor that resolves Y.js content.
// The engineFactory creates YDocEngine instances for each document.
// The textKey is the Y.Text shared type name (typically "source").
func NewProviderProcessor(p Provider, engineFactory YDocEngineFactory, textKey string) *ProviderProcessor {
	if textKey == "" {
		textKey = "source"
	}
	return &ProviderProcessor{
		provider:      p,
		engineFactory: engineFactory,
		textKey:       textKey,
		cache:         make(map[string]YDocEngine),
	}
}

// getOrCreateEngine returns the cached engine for a document, or creates one.
func (pp *ProviderProcessor) getOrCreateEngine(documentID string) YDocEngine {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	if engine, ok := pp.cache[documentID]; ok {
		return engine
	}
	engine := pp.engineFactory()
	pp.cache[documentID] = engine
	return engine
}

// ResolveStore applies Y.js updates to the cached doc and populates
// req.Content with the resolved text. Called by the HTTP handler before
// passing the request to the provider.
func (pp *ProviderProcessor) ResolveStore(documentID string, req *StoreRequest) {
	if len(req.Updates) == 0 {
		return
	}

	engine := pp.getOrCreateEngine(documentID)

	// Apply each update to the Y.Doc
	for _, u := range req.Updates {
		raw, err := base64.StdEncoding.DecodeString(u.Data)
		if err != nil {
			slog.Warn("skipping malformed update", "doc", documentID, "seq", u.Sequence, "err", err)
			continue
		}

		// Extract the Yjs update from the y-websocket frame.
		// Frame format: [messageType: varuint(0=sync)] [syncBody...]
		// We skip the first byte (message type) and use ygo's sync protocol
		// parser to extract the raw Yjs update from the sync body.
		yjsUpdate := extractYjsUpdate(raw)
		if yjsUpdate == nil {
			continue
		}

		if err := engine.ApplyUpdate(yjsUpdate); err != nil {
			slog.Warn("failed to apply update", "doc", documentID, "seq", u.Sequence, "err", err)
		}
	}

	// Extract resolved text
	req.Content = engine.GetText(pp.textKey)
	if req.MimeType == "" {
		req.MimeType = detectMimeType(documentID)
	}
}

// extractYjsUpdate strips the y-websocket frame header and returns the raw
// Yjs update bytes. Returns nil if the frame is not a sync-update message.
//
// y-websocket frame: [messageType: varuint] [syncBody...]
// The relay only buffers sync-update messages (messageType=0, syncType=2).
// We skip the first byte (messageType) and use ygo's sync protocol parser
// (ReadSyncMessage) to extract the payload.
func extractYjsUpdate(frame []byte) []byte {
	if len(frame) < 3 {
		return nil
	}

	// Skip the y-websocket messageType byte (0x00 = sync).
	// The rest is the sync protocol body.
	if frame[0] != 0x00 {
		return nil
	}

	// Use ygo's sync protocol parser to extract the update payload.
	msgType, payload, err := ysync.ReadSyncMessage(frame[1:])
	if err != nil {
		return nil
	}

	// Only accept sync-update (type 2) and sync-step2 (type 1) messages.
	// Step1 contains a state vector, not an update.
	if msgType != ysync.MsgSyncStep2 && msgType != ysync.MsgUpdate {
		return nil
	}

	return payload
}

// detectMimeType returns the MIME type based on the document file extension.
func detectMimeType(docID string) string {
	switch {
	case hasExtension(docID, ".md"):
		return "text/markdown"
	case hasExtension(docID, ".html"), hasExtension(docID, ".htm"):
		return "text/html"
	case hasExtension(docID, ".json"):
		return "application/json"
	case hasExtension(docID, ".py"):
		return "text/x-python"
	case hasExtension(docID, ".js"):
		return "text/javascript"
	case hasExtension(docID, ".jsx"):
		return "text/jsx"
	case hasExtension(docID, ".ts"):
		return "text/typescript"
	case hasExtension(docID, ".tsx"):
		return "text/tsx"
	default:
		return "text/plain"
	}
}

func hasExtension(name, ext string) bool {
	return len(name) > len(ext) && name[len(name)-len(ext):] == ext
}
