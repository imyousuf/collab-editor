package spi

import (
	"encoding/base64"
	"log/slog"
	"sync"
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
		// y-websocket frames start with: messageType (varuint) + syncType (varuint)
		// For sync-update messages: messageType=0, syncType=2, then the raw Yjs update.
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
// y-websocket frame format:
//
//	[messageType: varuint] [syncType: varuint] [yjsUpdate: bytes...]
//
// For sync-update: messageType=0 (sync), syncType=2 (update)
func extractYjsUpdate(frame []byte) []byte {
	if len(frame) < 2 {
		return nil
	}

	// Read messageType (varuint)
	msgType, n := readVaruint(frame)
	if n == 0 || msgType != 0 { // 0 = sync message
		return nil
	}

	// Read syncType (varuint)
	syncType, m := readVaruint(frame[n:])
	if m == 0 || syncType != 2 { // 2 = sync update
		return nil
	}

	return frame[n+m:]
}

// readVaruint reads a variable-length unsigned integer.
// Returns the value and number of bytes consumed (0 if invalid).
func readVaruint(data []byte) (uint64, int) {
	var value uint64
	var shift uint
	for i, b := range data {
		value |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return value, i + 1
		}
		shift += 7
		if shift > 63 {
			return 0, 0 // overflow
		}
	}
	return 0, 0 // incomplete
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
