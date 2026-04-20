"""Tests for the DocCache module."""

from __future__ import annotations

import pycrdt

from collab_editor_provider.cache import DocCache


class TestDocCache:
    def test_get_set_delete(self) -> None:
        cache = DocCache(10)
        doc = pycrdt.Doc()
        cache.set("doc1", doc)
        assert cache.get("doc1") is doc
        assert cache.size == 1

        cache.delete("doc1")
        assert cache.get("doc1") is None
        assert cache.size == 0

    def test_lru_eviction(self) -> None:
        cache = DocCache(2)
        cache.set("a", pycrdt.Doc())
        cache.set("b", pycrdt.Doc())
        cache.set("c", pycrdt.Doc())  # evicts "a"

        assert cache.get("a") is None
        assert cache.get("b") is not None
        assert cache.get("c") is not None

    def test_access_refreshes_lru_position(self) -> None:
        cache = DocCache(2)
        cache.set("a", pycrdt.Doc())
        cache.set("b", pycrdt.Doc())
        cache.get("a")  # refresh "a"
        cache.set("c", pycrdt.Doc())  # should evict "b", not "a"

        assert cache.get("a") is not None
        assert cache.get("b") is None
        assert cache.get("c") is not None

    def test_clear(self) -> None:
        cache = DocCache(10)
        cache.set("a", pycrdt.Doc())
        cache.set("b", pycrdt.Doc())
        cache.clear()
        assert cache.size == 0

    def test_overwrite_existing_key(self) -> None:
        cache = DocCache(2)
        doc1 = pycrdt.Doc()
        doc2 = pycrdt.Doc()
        cache.set("a", doc1)
        cache.set("a", doc2)
        assert cache.get("a") is doc2
        assert cache.size == 1

    def test_delete_nonexistent_key(self) -> None:
        cache = DocCache(10)
        cache.delete("nonexistent")  # should not raise
        assert cache.size == 0
