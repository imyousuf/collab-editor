# collab-editor-provider

Python SDK for implementing collab-editor storage providers.

## Installation

```bash
pip install collab-editor-provider
```

With FastAPI support:
```bash
pip install collab-editor-provider[fastapi]
```

## Quick Start

```python
from collab_editor_provider import Provider, ContentResult, create_fastapi_router, serve
from fastapi import FastAPI

class MyProvider(Provider):
    async def read_content(self, document_id: str) -> ContentResult:
        text = read_from_your_storage(document_id)
        return ContentResult(content=text, mime_type="text/plain")

    async def write_content(self, document_id: str, content: str, mime_type: str) -> None:
        save_to_your_storage(document_id, content)

# Option 1: FastAPI router
app = FastAPI()
app.include_router(create_fastapi_router(MyProvider()), prefix="/collab")

# Option 2: Standalone server
serve(MyProvider(), port=8081)

# Option 3: Manual processing
from collab_editor_provider import ProviderProcessor
processor = ProviderProcessor(MyProvider())
result = await processor.process_store(document_id, updates)
```
