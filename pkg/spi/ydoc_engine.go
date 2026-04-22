package spi

// YDocEngine abstracts Y.js document operations.
// The SDK uses this interface to apply updates and extract resolved text.
// Implementations can be swapped without touching SDK logic.
type YDocEngine interface {
	// ApplyUpdate applies a raw Yjs binary update to the internal document.
	ApplyUpdate(update []byte) error

	// GetText returns the current text content of the named shared type.
	GetText(name string) string

	// InsertText seeds the named shared type with initial text content.
	// Should only be called on an empty document.
	InsertText(name string, content string)

	// EncodeStateAsUpdate encodes the full document state as a Yjs V1 binary update.
	EncodeStateAsUpdate() []byte
}

// YDocEngineFactory creates new YDocEngine instances.
// Used by the ProviderProcessor to create one engine per document.
type YDocEngineFactory func() YDocEngine
