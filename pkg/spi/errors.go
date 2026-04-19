package spi

import "errors"

// ErrorResponse represents an error returned by the storage provider.
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// Sentinel errors for well-known provider responses.
var (
	ErrForbidden    = errors.New("spi: forbidden")
	ErrNotFound     = errors.New("spi: document not found")
	ErrLocked       = errors.New("spi: document locked")
	ErrStorageFull  = errors.New("spi: storage full")
	ErrProviderDown = errors.New("spi: provider unavailable")
)
