package yjsengine

import (
	"errors"
	"fmt"
)

// ReadSyncSubMessage parses a y-protocols/sync sub-frame body (the
// bytes AFTER the y-websocket envelope byte 0x00) and returns:
//
//   - msgType: MsgSyncStep1 / MsgSyncStep2 / MsgUpdate
//   - payload: the raw inner bytes (state vector for SyncStep1, full
//     update for SyncStep2/Update)
//
// Pure parser — does not touch any Y.Doc. The relay uses this in two
// places: to early-route inbound frames (broadcast vs. reply-only)
// and to extract the bare update payload for the durable event log
// (stateStore.AppendUpdate).
//
// Mirrors lib0's varuint format. Encoded as: varuint(type) +
// varuint(payloadLen) + payload bytes.
func ReadSyncSubMessage(body []byte) (msgType byte, payload []byte, err error) {
	t, off, err := readVarUint(body, 0)
	if err != nil {
		return 0, nil, err
	}
	switch t {
	case uint64(MsgSyncStep1), uint64(MsgSyncStep2), uint64(MsgUpdate):
		// fall through
	default:
		return byte(t), nil, fmt.Errorf("yjsengine: unknown sync sub-type %d", t)
	}
	plen, off, err := readVarUint(body, off)
	if err != nil {
		return 0, nil, err
	}
	if off+int(plen) > len(body) {
		return 0, nil, errors.New("yjsengine: short sync payload")
	}
	return byte(t), body[off : off+int(plen)], nil
}

// readVarUint decodes a lib0/yjs varuint starting at `off`. Returns
// the value, the new offset, and any error.
func readVarUint(buf []byte, off int) (uint64, int, error) {
	var n uint64
	var shift uint
	for {
		if off >= len(buf) {
			return 0, off, errors.New("yjsengine: varuint: unexpected eof")
		}
		b := buf[off]
		off++
		n |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return n, off, nil
		}
		shift += 7
		if shift > 63 {
			return 0, off, errors.New("yjsengine: varuint: overflow")
		}
	}
}
