# Basic Example

Run the full collaborative editor stack locally with Docker Compose.

## Quick Start

```bash
docker compose up --build
```

Open http://localhost:3000 in two browser tabs to test real-time collaboration.

## Services

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 3000 | Nginx serving the web component demo |
| Relay | 8080 | Go WebSocket relay server |
| Provider | 8081 | Demo filesystem storage provider |
| Metrics | 9090 | Prometheus metrics |

## Seed Documents

The `seed-documents/` directory contains sample files for testing different formats:

- `welcome.md` — Markdown document
- `page.html` — HTML document
- `script.py` — Python source file
- `app.jsx` — React component
