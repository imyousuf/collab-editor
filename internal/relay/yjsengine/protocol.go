package yjsengine

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Wire protocol for the relay ↔ yjs-engine sidecar Unix socket. Must
// match cmd/yjs-engine/index.js exactly. See cmd/yjs-engine/README.md
// for the human-readable spec.

const protocolVersion uint8 = 1

// Op codes — keep in lock-step with cmd/yjs-engine/index.js OP map.
const (
	opOpen        byte = 0x01
	opClose       byte = 0x02
	opApplyUpdate byte = 0x03
	opSyncMessage byte = 0x04
	opEncodeState byte = 0x05
	opEncodeSV    byte = 0x06
	opGetText     byte = 0x07
	opPing        byte = 0x08
)

// Status codes.
const (
	statusOK  byte = 0
	statusErr byte = 1
)

const headerLen = 11 // version(1) + length(4) + seq(4) + op(1) + status(1)

// errInvalidFrame indicates a malformed frame on the wire (truncated,
// version mismatch, etc.). Surfaced as a connection-level fatal — the
// supervisor should reset.
var errInvalidFrame = errors.New("yjsengine: invalid wire frame")

// frame holds a parsed wire message — used both for requests (status=0)
// and responses (status=0 OK / non-zero ERR with utf-8 message).
type frame struct {
	seq     uint32
	op      byte
	status  byte
	payload []byte
}

// encodeFrame writes a frame to dst. Frame layout:
//
//	[version u8][length u32 BE][seq u32 BE][op u8][status u8][payload]
//
// length covers everything after the length field.
func encodeFrame(dst []byte, f frame) []byte {
	bodyLen := 4 + 1 + 1 + len(f.payload) // seq + op + status + payload
	out := make([]byte, headerLen+len(f.payload))
	out[0] = protocolVersion
	binary.BigEndian.PutUint32(out[1:5], uint32(bodyLen))
	binary.BigEndian.PutUint32(out[5:9], f.seq)
	out[9] = f.op
	out[10] = f.status
	copy(out[headerLen:], f.payload)
	if dst != nil {
		// Caller may pre-allocate; honour it when sized correctly.
		if cap(dst) >= len(out) {
			return append(dst[:0], out...)
		}
	}
	return out
}

// readFrame reads a single frame from r. Returns io.EOF cleanly when
// the connection closes between frames; partial reads mid-frame are
// surfaced as errInvalidFrame.
func readFrame(r io.Reader) (frame, error) {
	header := make([]byte, headerLen)
	if _, err := io.ReadFull(r, header); err != nil {
		return frame{}, err
	}
	if header[0] != protocolVersion {
		return frame{}, fmt.Errorf("%w: protocol version %d (want %d)", errInvalidFrame, header[0], protocolVersion)
	}
	bodyLen := binary.BigEndian.Uint32(header[1:5])
	if bodyLen < 6 {
		return frame{}, fmt.Errorf("%w: body length %d too small", errInvalidFrame, bodyLen)
	}
	payloadLen := int(bodyLen) - 6 // seq+op+status already in header
	f := frame{
		seq:    binary.BigEndian.Uint32(header[5:9]),
		op:     header[9],
		status: header[10],
	}
	if payloadLen > 0 {
		f.payload = make([]byte, payloadLen)
		if _, err := io.ReadFull(r, f.payload); err != nil {
			return frame{}, fmt.Errorf("%w: short payload: %v", errInvalidFrame, err)
		}
	}
	return f, nil
}

// writeVarString writes a 16-bit-length-prefixed utf-8 string.
func writeVarString(buf []byte, s string) []byte {
	if len(s) > 0xffff {
		// docIDs are short; this is defensive.
		s = s[:0xffff]
	}
	hdr := []byte{byte(len(s) >> 8), byte(len(s))}
	buf = append(buf, hdr...)
	buf = append(buf, s...)
	return buf
}

// errFromStatus turns an error-status response payload into a Go error
// with sentinel mapping where applicable.
func errFromStatus(payload []byte) error {
	msg := string(payload)
	if len(msg) == 0 {
		msg = "unknown sidecar error"
	}
	// Map known sidecar error codes to sentinel errors so callers can
	// errors.Is. The sidecar prefixes its messages with `CODE: ...`.
	if len(msg) >= len("UNKNOWN_DOC:") && msg[:len("UNKNOWN_DOC:")] == "UNKNOWN_DOC:" {
		return fmt.Errorf("%w: %s", ErrUnknownDoc, msg)
	}
	return fmt.Errorf("yjsengine: sidecar: %s", msg)
}
