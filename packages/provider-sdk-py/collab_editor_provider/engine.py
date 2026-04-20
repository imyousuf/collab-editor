"""Yjs engine -- applies diffs, extracts text, manages Y.Doc lifecycle.

The relay sends y-websocket protocol messages (byte 0 = type, byte 1 = subtype).
Only sync update messages (0x00, 0x02) contain actual Yjs updates.
The engine strips the protocol header and applies the raw Yjs update.
"""

from __future__ import annotations

import base64

import pycrdt

TEXT_KEY = "source"


def _read_varuint(data: bytes, pos: int) -> tuple[int, int]:
    """Read a lib0 varuint from *data* starting at *pos*. Returns (value, new_pos)."""
    value = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        value |= (b & 0x7F) << shift
        pos += 1
        if b < 0x80:
            break
        shift += 7
    return value, pos


def extract_yjs_update(data: bytes) -> bytes | None:
    """Strip the y-websocket protocol header and return the raw Yjs update.

    Returns ``None`` if the message is not a sync-update (type=0, subtype=2).
    """
    if len(data) < 2:
        return None

    pos = 0
    message_type, pos = _read_varuint(data, pos)
    if message_type != 0:  # not a sync message
        return None

    sync_type, pos = _read_varuint(data, pos)
    if sync_type != 2:  # not an update (skip step1=0, step2=1)
        return None

    # Read varuint8array: length-prefixed byte array
    length, pos = _read_varuint(data, pos)
    if pos + length > len(data):
        return None

    return data[pos : pos + length]


def apply_base64_update(doc: pycrdt.Doc, base64_data: str) -> bool:
    """Apply a base64-encoded y-websocket message to a Doc. Returns True if applied."""
    raw = base64.b64decode(base64_data)
    yjs_update = extract_yjs_update(raw)
    if yjs_update is None:
        return False
    doc.apply_update(yjs_update)
    return True


def extract_text(doc: pycrdt.Doc) -> str:
    """Extract the full text from a Doc."""
    return str(doc.get(TEXT_KEY, type=pycrdt.Text))


def create_doc_with_content(content: str) -> pycrdt.Doc:
    """Create a Doc seeded with initial text content."""
    doc = pycrdt.Doc()
    text = doc.get(TEXT_KEY, type=pycrdt.Text)
    if content:
        text += content
    return doc


def encode_doc_state(doc: pycrdt.Doc) -> str:
    """Encode a Doc's full state as a base64 string."""
    state = doc.get_update()
    return base64.b64encode(state).decode("ascii")
