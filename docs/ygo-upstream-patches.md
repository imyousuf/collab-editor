# ygo: add support for lib0 Any tag 122 (BigInt64)

This document describes a one-case patch to `reearth/ygo`'s `Any` decoder
that is currently applied locally in this repository at
`third_party/ygo/encoding/decoder.go`. It is written as a self-contained
upstream PR description — copy the relevant sections directly into a PR
body when proposing the change to https://github.com/reearth/ygo.

Tested against `reearth/ygo v1.1.2`.

## Summary

`(*encoding.Decoder).ReadAny` rejects any payload that contains a
JavaScript `BigInt` value with `ErrUnknownTag`. lib0 (the encoder used
by the canonical [yjs](https://github.com/yjs/yjs) JavaScript
implementation) writes BigInt as Any tag **122** — see
[`lib0/encoding.js` writeAny](https://github.com/dmonad/lib0/blob/main/encoding.js)
— but ygo's `readAny` does not list `122` among its `case` branches, so
the decoder returns `ErrUnknownTag` and `crdt.ApplyUpdate` aborts with
`crdt: invalid update: encoding: unknown Any tag`.

The result is silent desynchronisation: any update containing a
JavaScript BigInt anywhere in its payload — including BigInts that
yjs/lib0 emit internally without the application's involvement — fails
to apply to the Go-side `Doc`. A relay or persistence layer that uses
ygo to maintain server-side state will diverge from peers, and any
state-vector exchange afterwards (SyncStep1 → SyncStep2) replays the
diverged state back to clients and corrupts the document.

## Reproduction

```go
package main

import (
    "fmt"
    "github.com/reearth/ygo/encoding"
)

func main() {
    // lib0 writeBigInt64(0n) — tag 122, 8 bytes big-endian.
    bytes := []byte{
        122,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
    }
    d := encoding.NewDecoder(bytes)
    v, err := d.ReadAny()
    fmt.Printf("v=%v err=%v\n", v, err)
    // Output (current):  v=<nil> err=encoding: unknown Any tag
    // Output (patched):  v=0    err=<nil>
}
```

In a relay scenario, the same failure surfaces inside
`crdt.ApplyUpdate` whenever an update contains a `Y.Map.set(key,
someBigInt)` operation — or, more commonly, when yjs emits a BigInt
internally as part of a content envelope that the application never
constructs by hand.

## Root cause

`encoding/decoder.go` `(*Decoder).readAny` handles every tag lib0 emits
**except** tag 122:

| Tag | lib0 type           | ygo `readAny` |
| --- | ------------------- | ------------- |
| 116 | Uint8Array          | ✅            |
| 117 | Array               | ✅            |
| 118 | Object              | ✅            |
| 119 | string              | ✅            |
| 120 | true                | ✅            |
| 121 | false               | ✅            |
| 122 | **BigInt64**        | ❌ ErrUnknownTag |
| 123 | float64             | ✅            |
| 124 | float32             | ✅            |
| 125 | varint (≤ 2^31)     | ✅            |
| 126 | null                | ✅            |
| 127 | undefined           | ✅            |

lib0 writes BigInt as 8 bytes big-endian via
[`DataView.setBigInt64(0, num, false)`](https://github.com/dmonad/lib0/blob/main/encoding.js)
(the `false` argument selects big-endian byte order). The matching
read is symmetric: 8 bytes big-endian, interpreted as a signed 64-bit
integer.

## Proposed fix

Add a single case to `(*Decoder).readAny` in `encoding/decoder.go`:

```go
case 122:
    // BigInt64 — lib0 writes 8 bytes big-endian via
    // DataView.setBigInt64(offset, value, /*littleEndian=*/false).
    if d.pos+8 > len(d.buf) {
        return nil, ErrUnexpectedEOF
    }
    v := int64(binary.BigEndian.Uint64(d.buf[d.pos:]))
    d.pos += 8
    return v, nil
```

The decoded value is returned as Go `int64`. JavaScript `BigInt` values
that don't fit in `int64` are out of scope — lib0 only writes the
`BigInt64` tag for values that fit in 64 bits, larger values fall
through to lib0's float64 path (tag 123). Returning `int64` matches the
shape of the existing `case 125` branch (`ReadVarInt` also returns
`int64`), so callers that already accept `any` for varint integers
need no further changes.

The encoder side already has `WriteAny` cases for the other 11 tags;
adding a symmetric `WriteAny` branch for Go `int64`-as-BigInt is
**deliberately omitted** in this PR. The decoder fix unblocks the
common interop path (Go reads what JS wrote); whether ygo should also
*emit* tag 122 for some Go-side type is a separate API design
question.

## Tests

Add to `encoding/decoder_test.go`:

```go
func TestReadAny_BigInt64_Zero(t *testing.T) {
    d := NewDecoder([]byte{122, 0, 0, 0, 0, 0, 0, 0, 0})
    got, err := d.ReadAny()
    require.NoError(t, err)
    require.Equal(t, int64(0), got)
}

func TestReadAny_BigInt64_Positive(t *testing.T) {
    // 1 in big-endian int64.
    d := NewDecoder([]byte{122, 0, 0, 0, 0, 0, 0, 0, 1})
    got, err := d.ReadAny()
    require.NoError(t, err)
    require.Equal(t, int64(1), got)
}

func TestReadAny_BigInt64_Negative(t *testing.T) {
    // -1 in big-endian two's complement int64.
    d := NewDecoder([]byte{122, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
    got, err := d.ReadAny()
    require.NoError(t, err)
    require.Equal(t, int64(-1), got)
}

func TestReadAny_BigInt64_Truncated(t *testing.T) {
    // Tag present, but only 4 of the required 8 payload bytes.
    d := NewDecoder([]byte{122, 0, 0, 0, 0})
    _, err := d.ReadAny()
    require.ErrorIs(t, err, ErrUnexpectedEOF)
}
```

Round-trip coverage with the canonical lib0 fixtures (if the project
maintains any) is also worth adding.

## Backward compatibility

The change adds one new accepted tag value. Inputs that previously
errored with `ErrUnknownTag` will now succeed; inputs that previously
succeeded behave identically. No public API surface changes.

## Why this matters in practice

In a real deployment of [collab-editor](https://github.com/imyousuf/collab-editor)
(a yjs-based collaborative editor whose relay uses ygo to apply
updates server-side), tag-122 rejections triggered on virtually every
edit. The chain of failure was:

1. Browser sends a Yjs update over the websocket.
2. Update contains a BigInt somewhere in its payload (most commonly
   via a content envelope yjs constructs internally; the application
   itself never calls `BigInt(...)`).
3. Relay's `ygo.ApplyUpdate` returns `unknown Any tag` and the relay
   drops the update.
4. Relay's in-memory `Doc` falls behind the canonical client state.
5. On any state-vector exchange afterwards, the relay sends a
   `SyncStep2` derived from the stale `Doc`, which arrives at clients
   as inbound mutations and corrupts the document text.

User-visible symptom: the document title (a few characters at the
start of the doc) progressively garbled across reloads — e.g.
`"Welcome to Collab Editor - 1020"` → `"Welcome to Collab Editor0203"`
→ further variants on each subsequent edit, with `BigInt`-tag-122
emissions multiplying the divergence.

The decoder fix above eliminates the divergence at the source. (We
added a separate "tolerate apply-failures by still broadcasting raw
bytes" defence in our relay, but that is a belt-and-braces measure;
the decoder fix is the proper resolution.)

## Local patch reference

The patch is currently applied locally in this repository at:

- `third_party/ygo/encoding/decoder.go` — the patched copy of upstream
  `v1.1.2`.
- `go.mod` — `replace github.com/reearth/ygo => ./third_party/ygo`
  directive.
- `docker/relay.Dockerfile`, `docker/demo-provider.Dockerfile` — copy
  `third_party/` before `go mod download` so the replace target is on
  disk at build time.

When upstream merges and releases this fix, the plan is:

1. Bump the `reearth/ygo` version pin in `go.mod`.
2. Remove the `replace` directive.
3. Delete `third_party/ygo/`.
4. Revert the Dockerfile additions for `third_party/` (the lines are
   only needed while the local fork exists).

## References

- [yjs](https://github.com/yjs/yjs)
- [lib0 encoding.js — `writeAny` and `writeBigInt64`](https://github.com/dmonad/lib0/blob/main/encoding.js)
- [reearth/ygo — `encoding/decoder.go`](https://github.com/reearth/ygo/blob/main/encoding/decoder.go)
- [collab-editor — relay use of ygo](https://github.com/imyousuf/collab-editor/blob/main/internal/relay/room.go)

## Suggested PR title

> encoding: add Any tag 122 (BigInt64) decoding

## Suggested PR labels

`bug`, `interop`, `decoder`
