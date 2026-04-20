"""LRU cache for pycrdt.Doc instances, keyed by document ID."""

from __future__ import annotations

from collections import OrderedDict

import pycrdt


class DocCache:
    """Bounded LRU cache for Y.Doc instances.

    Keeps hot documents in memory to avoid re-creating on every store call.
    """

    def __init__(self, max_size: int = 1000) -> None:
        self._cache: OrderedDict[str, pycrdt.Doc] = OrderedDict()
        self._max_size = max_size

    def get(self, document_id: str) -> pycrdt.Doc | None:
        if document_id not in self._cache:
            return None
        self._cache.move_to_end(document_id)
        return self._cache[document_id]

    def set(self, document_id: str, doc: pycrdt.Doc) -> None:
        if document_id in self._cache:
            self._cache.move_to_end(document_id)
            self._cache[document_id] = doc
        else:
            if len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)  # evict LRU
            self._cache[document_id] = doc

    def delete(self, document_id: str) -> None:
        self._cache.pop(document_id, None)

    def clear(self) -> None:
        self._cache.clear()

    @property
    def size(self) -> int:
        return len(self._cache)
