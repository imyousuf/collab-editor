# yjs-engine

Out-of-process `Y.Doc` host for the [collab-editor](https://github.com/imyousuf/collab-editor) relay.

The relay (Go) was originally backed by an in-process Go port of yjs
(`reearth/ygo`). Subtle wire-format and integration-time divergences
between ygo and the canonical [yjs](https://github.com/yjs/yjs) npm
package surfaced as user-visible content corruption ("title got
auto-changed"). To eliminate that class of bug, the relay's per-room
`Y.Doc` state lives in this Node sidecar instead. The sidecar speaks
the canonical lib0/yjs wire format because it *is* lib0/yjs.

## Architecture

- One sidecar process per relay instance.
- Multiple `Y.Doc`s in memory, keyed by docID.
- Listens on a Unix domain socket from `$YJS_ENGINE_SOCK`.
- Length-prefixed binary protocol (see below). The relay's Go client
  is in `internal/relay/yjsengine/sidecar_client.go`.
- Pure applier — never originates writes. Bootstrap inserts are
  encoded by the Go side using ygo (with a pinned clientID) and
  shipped via `APPLY_UPDATE`. yjs's `Y.Doc` constructor doesn't
  accept a clientID.

## Protocol

Frame format (request and response use the same shape):

```
┌─────────────┬────────────┬───────────┬──────────┬──────────┬──────────┐
│ version u8  │ length u32 │ seq u32   │ op u8    │ status u8│ payload  │
│ (currently 1)│  (BE)     │  (BE)     │          │ req=0    │          │
└─────────────┴────────────┴───────────┴──────────┴──────────┴──────────┘
```

`length` covers everything after itself (seq + op + status + payload).
Responses set `status = 0` for OK, `status = 1` for error (payload =
utf-8 message).

### Operations

| Op   | Name           | Request payload                          | Response payload                             |
|------|----------------|------------------------------------------|----------------------------------------------|
| 0x01 | `OPEN`         | docID varstring                          | (empty) — idempotent                          |
| 0x02 | `CLOSE`        | docID varstring                          | (empty) — idempotent                          |
| 0x03 | `APPLY_UPDATE` | docID varstring + update bytes           | (empty)                                      |
| 0x04 | `SYNC_MESSAGE` | docID varstring + sync-frame body (no envelope) | msgType u8 + optional reply bytes (no envelope) |
| 0x05 | `ENCODE_STATE` | docID varstring                          | state-as-update bytes                        |
| 0x06 | `ENCODE_SV`    | docID varstring                          | state-vector bytes                           |
| 0x07 | `GET_TEXT`     | docID varstring + name varstring         | utf-8 string                                 |
| 0x08 | `PING`         | (empty)                                  | (empty)                                      |

`varstring` = `length u16 (BE) + utf-8 bytes`.

`SYNC_MESSAGE` is the workhorse — it consumes a y-protocols/sync
sub-frame body (the bytes AFTER the y-websocket envelope byte 0x00)
and returns the optional reply (also without envelope). This op
atomically reads-state-vector + applies + generates-reply for
SyncStep1, so callers must never split it into `ENCODE_SV` +
`ENCODE_STATE` — that would produce stale SyncStep2 replies under
concurrent writes.

## Running standalone (for tests / smoke checks)

```sh
cd cmd/yjs-engine
npm install
YJS_ENGINE_SOCK=/tmp/yjs-engine.sock node index.js
```

Stdout line `yjs-engine ready sock=/tmp/yjs-engine.sock pid=N` signals
readiness — supervisors should wait for it before sending the first
request.

## Lifecycle

- Relay spawns the sidecar as a child process at startup. Sidecar
  exits on SIGTERM / SIGINT.
- On crash, the relay's supervisor restarts with exponential backoff
  and re-opens all live rooms by replaying their state from
  `stateStore.ReadSnapshot` + `ReadLogTail` (and for the unflushed
  tail, drains the relay's buffer into the new sidecar).
- `CLOSE` is sent by the relay's `RoomManager` idle-timeout path. If
  it isn't, the sidecar leaks memory; monitor `PING` to keep an eye
  on doc count.

## Memory

One `Y.Doc` per docID. yjs GCs deleted items by default (`gc: true`).
A doc that never gets a `CLOSE` will grow with edit history; rely on
the relay's idle removal to keep this bounded.
