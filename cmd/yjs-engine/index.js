#!/usr/bin/env node
// Yjs sidecar for the collab-editor relay.
//
// Listens on a Unix domain socket (path from $YJS_ENGINE_SOCK) and
// processes a length-prefixed binary protocol. The relay (Go) is the
// only client. See cmd/yjs-engine/README.md for the full protocol
// spec; the matching Go side lives in internal/relay/yjsengine/.
//
// This sidecar is a PURE APPLIER — it never originates Y.Doc writes.
// Bootstrap inserts (seed text) are encoded by the Go side using the
// pinned serverClientID and shipped via APPLY_UPDATE. yjs's Y.Doc
// constructor doesn't accept clientID, so pinning here is unsafe.
//
// Memory: one Y.Doc per docID, lives until CLOSE. The relay's
// RoomManager idle-timeout path is responsible for sending CLOSE; if
// it doesn't, this process leaks. Exit on supervisor SIGTERM.

'use strict';

const fs = require('fs');
const net = require('net');
const Y = require('yjs');

const PROTOCOL_VERSION = 1;

// Op codes — keep aligned with internal/relay/yjsengine/protocol.go.
const OP = Object.freeze({
  OPEN: 0x01,
  CLOSE: 0x02,
  APPLY_UPDATE: 0x03,
  SYNC_MESSAGE: 0x04,
  ENCODE_STATE: 0x05,
  ENCODE_SV: 0x06,
  GET_TEXT: 0x07,
  PING: 0x08,
});

// Sync sub-types — match y-protocols/sync (and ygo's MsgSyncStep1/2/Update).
const MSG_SYNC_STEP1 = 0;
const MSG_SYNC_STEP2 = 1;
const MSG_UPDATE = 2;

const STATUS_OK = 0;
const STATUS_ERR = 1;

// ────────────────────────────────────────────────────────────────────
// Doc registry
// ────────────────────────────────────────────────────────────────────

const docs = new Map(); // docID → Y.Doc

function openDoc(docID) {
  let doc = docs.get(docID);
  if (!doc) {
    doc = new Y.Doc({ gc: true });
    docs.set(docID, doc);
  }
  return doc;
}

function closeDoc(docID) {
  const doc = docs.get(docID);
  if (doc) {
    doc.destroy();
    docs.delete(docID);
  }
}

function getDoc(docID) {
  const doc = docs.get(docID);
  if (!doc) {
    const e = new Error(`unknown doc: ${docID}`);
    e.code = 'UNKNOWN_DOC';
    throw e;
  }
  return doc;
}

// ────────────────────────────────────────────────────────────────────
// Wire codec — must match internal/relay/yjsengine/protocol.go
//
// Frame: [version u8][length u32 BE][seq u32 BE][op u8][status u8][payload]
// `length` covers everything after itself. Payload is op-specific.
// ────────────────────────────────────────────────────────────────────

const HEADER_BYTES = 1 /* version */ + 4 /* length */ + 4 /* seq */ + 1 /* op */ + 1 /* status */;

function readVarString(buf, offset) {
  const len = buf.readUInt16BE(offset);
  const bytes = buf.slice(offset + 2, offset + 2 + len);
  return { value: bytes.toString('utf8'), next: offset + 2 + len };
}

function writeVarString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

function buildFrame(seq, op, status, payload) {
  const payloadBuf = payload || Buffer.alloc(0);
  // length covers seq+op+status+payload (everything after the length field).
  const length = 4 + 1 + 1 + payloadBuf.length;
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payloadBuf.length);
  frame.writeUInt8(PROTOCOL_VERSION, 0);
  frame.writeUInt32BE(length, 1);
  frame.writeUInt32BE(seq, 5);
  frame.writeUInt8(op, 9);
  frame.writeUInt8(status, 10);
  payloadBuf.copy(frame, HEADER_BYTES);
  return frame;
}

// ────────────────────────────────────────────────────────────────────
// Op handlers
// ────────────────────────────────────────────────────────────────────

function handleOpen(payload) {
  const { value: docID } = readVarString(payload, 0);
  openDoc(docID);
  return Buffer.alloc(0);
}

function handleClose(payload) {
  const { value: docID } = readVarString(payload, 0);
  closeDoc(docID);
  return Buffer.alloc(0);
}

function handleApplyUpdate(payload) {
  const { value: docID, next } = readVarString(payload, 0);
  const update = payload.slice(next);
  const doc = getDoc(docID);
  if (update.length > 0) {
    Y.applyUpdate(doc, update);
  }
  return Buffer.alloc(0);
}

function handleSyncMessage(payload) {
  const { value: docID, next } = readVarString(payload, 0);
  const syncBody = payload.slice(next);
  const doc = getDoc(docID);

  // Re-implement y-protocols/sync's readSyncMessage inline. We keep
  // this dependency-free (no y-protocols pkg) to minimise the sidecar's
  // npm surface. Format: varuint type + varbytes body.
  const decoder = createDecoder(syncBody);
  const msgType = readVarUint(decoder);

  let replyBytes = Buffer.alloc(0);
  if (msgType === MSG_SYNC_STEP1) {
    const sv = readVarUint8Array(decoder);
    const update = Y.encodeStateAsUpdate(doc, sv);
    // Build a SyncStep2 reply: varuint(MSG_SYNC_STEP2) + varbytes(update).
    const enc = createEncoder();
    writeVarUint(enc, MSG_SYNC_STEP2);
    writeVarUint8Array(enc, update);
    replyBytes = encoderToBuffer(enc);
  } else if (msgType === MSG_SYNC_STEP2 || msgType === MSG_UPDATE) {
    const update = readVarUint8Array(decoder);
    if (update.length > 0) {
      Y.applyUpdate(doc, update);
    }
    // No reply for Step2/Update.
  } else {
    const err = new Error(`unknown sync sub-type ${msgType}`);
    err.code = 'BAD_SYNC_TYPE';
    throw err;
  }

  // Response payload: msgType u8 + reply bytes.
  const out = Buffer.allocUnsafe(1 + replyBytes.length);
  out.writeUInt8(msgType, 0);
  replyBytes.copy(out, 1);
  return out;
}

function handleEncodeState(payload) {
  const { value: docID } = readVarString(payload, 0);
  const doc = getDoc(docID);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

function handleEncodeSV(payload) {
  const { value: docID } = readVarString(payload, 0);
  const doc = getDoc(docID);
  return Buffer.from(Y.encodeStateVector(doc));
}

function handleGetText(payload) {
  const { value: docID, next } = readVarString(payload, 0);
  const { value: name } = readVarString(payload, next);
  const doc = getDoc(docID);
  return Buffer.from(doc.getText(name).toString(), 'utf8');
}

function handlePing() {
  return Buffer.alloc(0);
}

const HANDLERS = {
  [OP.OPEN]: handleOpen,
  [OP.CLOSE]: handleClose,
  [OP.APPLY_UPDATE]: handleApplyUpdate,
  [OP.SYNC_MESSAGE]: handleSyncMessage,
  [OP.ENCODE_STATE]: handleEncodeState,
  [OP.ENCODE_SV]: handleEncodeSV,
  [OP.GET_TEXT]: handleGetText,
  [OP.PING]: handlePing,
};

// ────────────────────────────────────────────────────────────────────
// lib0-compatible varuint encoding (kept inline; matches what yjs
// uses on the wire so SYNC_MESSAGE replies are byte-for-byte
// indistinguishable from y-protocols output).
// ────────────────────────────────────────────────────────────────────

function createDecoder(buf) {
  return { buf, pos: 0 };
}

function readVarUint(d) {
  let n = 0;
  let shift = 0;
  for (;;) {
    if (d.pos >= d.buf.length) throw new Error('readVarUint: unexpected eof');
    const b = d.buf[d.pos++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return n >>> 0;
    shift += 7;
    if (shift > 35) throw new Error('readVarUint: overflow');
  }
}

function readVarUint8Array(d) {
  const len = readVarUint(d);
  if (d.pos + len > d.buf.length) throw new Error('readVarUint8Array: short buffer');
  const out = d.buf.slice(d.pos, d.pos + len);
  d.pos += len;
  return out;
}

function createEncoder() {
  return { chunks: [], length: 0 };
}

function writeVarUint(e, n) {
  // VarUints up to ~2^35 fit in this loop; lib0's max is 53 bits but
  // sync sub-types and lengths used here are all small.
  while (n > 0x7f) {
    e.chunks.push(Buffer.from([0x80 | (n & 0x7f)]));
    e.length += 1;
    n >>>= 7;
  }
  e.chunks.push(Buffer.from([n & 0x7f]));
  e.length += 1;
}

function writeVarUint8Array(e, bytes) {
  writeVarUint(e, bytes.length);
  e.chunks.push(Buffer.from(bytes));
  e.length += bytes.length;
}

function encoderToBuffer(e) {
  return Buffer.concat(e.chunks, e.length);
}

// ────────────────────────────────────────────────────────────────────
// Connection loop
// ────────────────────────────────────────────────────────────────────

function processFrame(frame) {
  // frame: full bytes including the version+length prefix.
  const version = frame.readUInt8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`protocol version mismatch: got ${version}, want ${PROTOCOL_VERSION}`);
  }
  const seq = frame.readUInt32BE(5);
  const op = frame.readUInt8(9);
  // status u8 at byte 10 is request=0; we ignore it for requests.
  const payload = frame.slice(HEADER_BYTES);
  const handler = HANDLERS[op];
  if (!handler) {
    return buildFrame(seq, op, STATUS_ERR, Buffer.from(`unknown op 0x${op.toString(16)}`, 'utf8'));
  }
  try {
    const responsePayload = handler(payload);
    return buildFrame(seq, op, STATUS_OK, responsePayload);
  } catch (err) {
    const msg = `${err.code || 'ERR'}: ${err.message}`;
    return buildFrame(seq, op, STATUS_ERR, Buffer.from(msg, 'utf8'));
  }
}

function attachConnection(sock) {
  let buffer = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Try to decode as many full frames as are available.
    for (;;) {
      if (buffer.length < 5) return;
      const length = buffer.readUInt32BE(1);
      const total = 1 + 4 + length; // version + length + (covered)
      if (buffer.length < total) return;
      const frame = buffer.slice(0, total);
      buffer = buffer.slice(total);
      const response = processFrame(frame);
      sock.write(response);
    }
  });
  sock.on('error', (err) => {
    process.stderr.write(`client error: ${err.message}\n`);
  });
}

function main() {
  const sockPath = process.env.YJS_ENGINE_SOCK;
  if (!sockPath) {
    process.stderr.write('YJS_ENGINE_SOCK env not set\n');
    process.exit(2);
  }
  // Remove stale socket if present (relay sends SIGTERM on shutdown
  // but a crash can leave one behind).
  try {
    fs.unlinkSync(sockPath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      process.stderr.write(`cannot remove stale socket ${sockPath}: ${e.message}\n`);
      process.exit(2);
    }
  }
  const server = net.createServer(attachConnection);
  server.on('error', (err) => {
    process.stderr.write(`server error: ${err.message}\n`);
    process.exit(2);
  });
  server.listen(sockPath, () => {
    // Stdout line is the relay's readiness signal.
    process.stdout.write(`yjs-engine ready sock=${sockPath} pid=${process.pid}\n`);
  });

  const shutdown = (sig) => {
    process.stderr.write(`yjs-engine shutting down (${sig})\n`);
    server.close(() => {
      try { fs.unlinkSync(sockPath); } catch (_) { /* ignore */ }
      process.exit(0);
    });
    // Force exit after grace.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main();
}

module.exports = { PROTOCOL_VERSION, OP, processFrame, buildFrame };
