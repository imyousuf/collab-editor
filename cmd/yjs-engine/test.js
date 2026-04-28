#!/usr/bin/env node
// In-process smoke test for the yjs-engine sidecar protocol.
// Runs every op against an in-memory canonical yjs doc as the oracle
// and asserts the responses match.
//
// Run: `node test.js`. Exit 0 on success, non-zero on first failure.
//
// This is the JS-side counterpart to the Go contract tests in
// internal/relay/yjsengine/engine_test.go. The Go-side SidecarEngine
// will run the same contract tests against a live sidecar process in
// C3.

'use strict';

const Y = require('yjs');
const { OP, processFrame, buildFrame, PROTOCOL_VERSION } = require('./index');

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    process.stdout.write(`✓ ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`✗ ${name} — ${detail || ''}\n`);
}

function buildRequest(seq, op, payload) {
  return buildFrame(seq, op, 0, payload);
}

function decodeResponse(buf) {
  return {
    version: buf.readUInt8(0),
    length: buf.readUInt32BE(1),
    seq: buf.readUInt32BE(5),
    op: buf.readUInt8(9),
    status: buf.readUInt8(10),
    payload: buf.slice(11),
  };
}

function varStr(s) {
  const bytes = Buffer.from(s, 'utf8');
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

// ── PING ─────────────────────────────────────────────────────────────
{
  const resp = decodeResponse(processFrame(buildRequest(1, OP.PING, Buffer.alloc(0))));
  check('PING returns OK', resp.status === 0 && resp.payload.length === 0,
    `status=${resp.status} payload=${resp.payload.length}B`);
}

// ── OPEN + APPLY_UPDATE + GET_TEXT ──────────────────────────────────
{
  // Open doc-1 in the sidecar.
  decodeResponse(processFrame(buildRequest(2, OP.OPEN, varStr('doc-1'))));

  // Build a real Yjs update via a peer doc.
  const peer = new Y.Doc({ gc: true });
  peer.getText('source').insert(0, 'hello world');
  const update = Y.encodeStateAsUpdate(peer);

  // Apply via the sidecar.
  const applyPayload = Buffer.concat([varStr('doc-1'), Buffer.from(update)]);
  const applyResp = decodeResponse(processFrame(buildRequest(3, OP.APPLY_UPDATE, applyPayload)));
  check('APPLY_UPDATE returns OK', applyResp.status === 0,
    `status=${applyResp.status} err=${applyResp.payload.toString()}`);

  // Read the text back.
  const getPayload = Buffer.concat([varStr('doc-1'), varStr('source')]);
  const getResp = decodeResponse(processFrame(buildRequest(4, OP.GET_TEXT, getPayload)));
  const text = getResp.payload.toString('utf8');
  check('GET_TEXT round-trips', getResp.status === 0 && text === 'hello world',
    `status=${getResp.status} text=${JSON.stringify(text)}`);
}

// ── SYNC_MESSAGE step1 → step2 ──────────────────────────────────────
{
  // Build a SyncStep1 from a fresh peer (empty state vector).
  const peer = new Y.Doc({ gc: true });

  // Encode SyncStep1 inline (varuint type=0 + varbytes(state vector)).
  const sv = Y.encodeStateVector(peer);
  const encodeVarUint = (n, out) => {
    while (n > 0x7f) { out.push(0x80 | (n & 0x7f)); n >>>= 7; }
    out.push(n & 0x7f);
  };
  const out = [];
  encodeVarUint(0, out);                  // MSG_SYNC_STEP1
  encodeVarUint(sv.length, out);           // varuint(len)
  for (const b of sv) out.push(b);
  const step1Body = Buffer.from(out);

  const syncPayload = Buffer.concat([varStr('doc-1'), step1Body]);
  const resp = decodeResponse(processFrame(buildRequest(5, OP.SYNC_MESSAGE, syncPayload)));
  check('SYNC_MESSAGE step1 returns OK', resp.status === 0,
    `status=${resp.status} err=${resp.payload.toString()}`);

  // Response payload: msgType u8 + reply bytes.
  const msgType = resp.payload.readUInt8(0);
  const reply = resp.payload.slice(1);
  check('SYNC_MESSAGE msgType=0 (Step1)', msgType === 0, `msgType=${msgType}`);
  check('SYNC_MESSAGE reply non-empty', reply.length > 0, `reply len=${reply.length}`);

  // Decode reply on the peer: it's a SyncStep2 (varuint(1) + varbytes(update)).
  let pos = 0;
  let n = 0, shift = 0;
  for (;;) {
    const b = reply[pos++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  check('SYNC_MESSAGE reply is Step2', n === 1, `replyType=${n}`);
  // Read varuint length, then update bytes.
  let updLen = 0; shift = 0;
  for (;;) {
    const b = reply[pos++];
    updLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const updateBytes = reply.slice(pos, pos + updLen);
  Y.applyUpdate(peer, updateBytes);
  check('peer applies Step2 → text matches sidecar',
    peer.getText('source').toString() === 'hello world',
    `peer text=${JSON.stringify(peer.getText('source').toString())}`);
}

// ── ENCODE_STATE round-trips through a fresh peer ───────────────────
{
  const resp = decodeResponse(processFrame(buildRequest(6, OP.ENCODE_STATE, varStr('doc-1'))));
  check('ENCODE_STATE returns OK', resp.status === 0,
    `status=${resp.status} err=${resp.payload.toString()}`);
  check('ENCODE_STATE non-empty', resp.payload.length > 0, `len=${resp.payload.length}`);

  const peer = new Y.Doc({ gc: true });
  Y.applyUpdate(peer, resp.payload);
  check('ENCODE_STATE round-trips on a fresh peer',
    peer.getText('source').toString() === 'hello world',
    `peer text=${JSON.stringify(peer.getText('source').toString())}`);
}

// ── ENCODE_SV is non-empty after writes ─────────────────────────────
{
  const resp = decodeResponse(processFrame(buildRequest(7, OP.ENCODE_SV, varStr('doc-1'))));
  check('ENCODE_SV returns OK', resp.status === 0,
    `status=${resp.status} err=${resp.payload.toString()}`);
  check('ENCODE_SV non-empty', resp.payload.length > 0, `len=${resp.payload.length}`);
}

// ── CLOSE + op-on-closed-doc returns ERR ────────────────────────────
{
  const resp = decodeResponse(processFrame(buildRequest(8, OP.CLOSE, varStr('doc-1'))));
  check('CLOSE returns OK', resp.status === 0, `status=${resp.status}`);

  // Op on closed doc should return ERR (UNKNOWN_DOC).
  const getPayload = Buffer.concat([varStr('doc-1'), varStr('source')]);
  const getResp = decodeResponse(processFrame(buildRequest(9, OP.GET_TEXT, getPayload)));
  check('GET_TEXT after CLOSE returns ERR', getResp.status === 1 &&
    getResp.payload.toString().includes('UNKNOWN_DOC'),
    `status=${getResp.status} payload=${getResp.payload.toString()}`);
}

// ── Unknown op returns ERR ──────────────────────────────────────────
{
  const resp = decodeResponse(processFrame(buildFrame(10, 0xff, 0, Buffer.alloc(0))));
  check('Unknown op returns ERR', resp.status === 1, `status=${resp.status}`);
}

// ── Frame version ───────────────────────────────────────────────────
{
  const resp = processFrame(buildRequest(11, OP.PING, Buffer.alloc(0)));
  check('Response carries protocol version', resp.readUInt8(0) === PROTOCOL_VERSION,
    `version=${resp.readUInt8(0)}`);
}

if (failures > 0) {
  process.stdout.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write('\nall checks passed\n');
