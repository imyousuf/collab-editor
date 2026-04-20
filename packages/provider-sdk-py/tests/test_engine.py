"""Tests for the Yjs engine module."""

from __future__ import annotations

import base64

import pycrdt

from collab_editor_provider.engine import (
    apply_base64_update,
    create_doc_with_content,
    encode_doc_state,
    extract_text,
    extract_yjs_update,
)
from .conftest import load_fixture


class TestExtractYjsUpdate:
    def test_extracts_sync_update(self) -> None:
        """Build a real y-websocket sync update message and verify extraction."""
        doc = pycrdt.Doc()
        text = doc.get("source", type=pycrdt.Text)
        text += "test"
        raw_update = doc.get_update()

        # Manually wrap: varuint(0) + varuint(2) + varuint8array(update)
        def write_varuint(v: int) -> bytes:
            out = bytearray()
            while v > 0x7F:
                out.append((v & 0x7F) | 0x80)
                v >>= 7
            out.append(v & 0x7F)
            return bytes(out)

        envelope = (
            write_varuint(0)  # messageSync
            + write_varuint(2)  # syncUpdate
            + write_varuint(len(raw_update))
            + raw_update
        )

        extracted = extract_yjs_update(envelope)
        assert extracted is not None
        assert len(extracted) > 0

        # Apply to a new doc and verify
        doc2 = pycrdt.Doc()
        text2 = doc2.get("source", type=pycrdt.Text)
        doc2.apply_update(extracted)
        assert str(text2) == "test"

    def test_returns_none_for_awareness(self) -> None:
        data = bytes([1, 0x01, 0x02])
        assert extract_yjs_update(data) is None

    def test_returns_none_for_sync_step1(self) -> None:
        data = bytes([0, 0, 0x01])
        assert extract_yjs_update(data) is None

    def test_returns_none_for_empty_data(self) -> None:
        assert extract_yjs_update(b"") is None
        assert extract_yjs_update(bytes([0])) is None

    def test_returns_none_for_sync_step2(self) -> None:
        data = bytes([0, 1, 0x01])
        assert extract_yjs_update(data) is None


class TestApplyBase64Update:
    def test_applies_valid_update(self) -> None:
        fixture = load_fixture("001-simple-insert")
        doc = pycrdt.Doc()
        doc.get("source", type=pycrdt.Text)

        for update in fixture["updates"]:
            apply_base64_update(doc, update["data"])

        assert extract_text(doc) == fixture["expected_text"]

    def test_returns_false_for_non_update(self) -> None:
        doc = pycrdt.Doc()
        doc.get("source", type=pycrdt.Text)
        # Awareness message base64
        result = apply_base64_update(doc, base64.b64encode(bytes([1, 0x01])).decode())
        assert result is False

    def test_returns_true_for_update(self) -> None:
        fixture = load_fixture("001-simple-insert")
        doc = pycrdt.Doc()
        doc.get("source", type=pycrdt.Text)
        result = apply_base64_update(doc, fixture["updates"][0]["data"])
        assert result is True


class TestCreateDocWithContent:
    def test_creates_doc_with_text(self) -> None:
        doc = create_doc_with_content("hello world")
        assert str(doc.get("source", type=pycrdt.Text)) == "hello world"

    def test_creates_empty_doc(self) -> None:
        doc = create_doc_with_content("")
        assert str(doc.get("source", type=pycrdt.Text)) == ""


class TestEncodeDocState:
    def test_round_trips(self) -> None:
        doc1 = create_doc_with_content("test content")
        encoded = encode_doc_state(doc1)

        doc2 = pycrdt.Doc()
        doc2.get("source", type=pycrdt.Text)
        raw = base64.b64decode(encoded)
        doc2.apply_update(raw)

        assert str(doc2.get("source", type=pycrdt.Text)) == "test content"


class TestSharedFixtures:
    """Run all shared JSON fixtures through the engine."""

    def test_fixture(self, fixture_data: dict) -> None:
        doc = pycrdt.Doc()
        doc.get("source", type=pycrdt.Text)

        for update in fixture_data["updates"]:
            apply_base64_update(doc, update["data"])

        assert extract_text(doc) == fixture_data["expected_text"]
