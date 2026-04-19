"""
Sample Python script for collaborative editing demo.
"""

import json
from typing import List, Dict


class DocumentStore:
    """Simple in-memory document store."""

    def __init__(self):
        self.documents: Dict[str, str] = {}

    def load(self, doc_id: str) -> str | None:
        return self.documents.get(doc_id)

    def save(self, doc_id: str, content: str) -> None:
        self.documents[doc_id] = content

    def delete(self, doc_id: str) -> bool:
        return self.documents.pop(doc_id, None) is not None

    def list_documents(self) -> List[str]:
        return list(self.documents.keys())


def main():
    store = DocumentStore()
    store.save("readme", "# Hello World")
    store.save("notes", "Meeting notes for today")

    print(f"Documents: {store.list_documents()}")
    print(f"Content: {json.dumps(store.load('readme'))}")


if __name__ == "__main__":
    main()
