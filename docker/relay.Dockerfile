# Multi-stage build: Go relay + Node yjs-engine sidecar.
#
# The sidecar (cmd/yjs-engine) runs the canonical yjs npm package
# out-of-process; the relay binary forks it as a child at startup.
# We ship both together so a single container is a complete relay
# instance.
#
# third_party/ is copied before `go mod download` because go.mod uses
# `replace github.com/reearth/ygo => ./third_party/ygo` — a locally
# patched fork that adds lib0 tag 122 (bigint64) decoding. Without the
# replace target on disk, `go mod download` errors before the rest of
# the source is copied. The patched ygo is still used by the SDK side
# (pkg/spi) for SPI flush-time text resolution; the relay itself goes
# through the sidecar for all live wire-path state.

FROM golang:1.26-alpine AS go-builder
WORKDIR /build
COPY go.mod go.sum ./
COPY third_party ./third_party
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /relay ./cmd/relay

# Pre-install the sidecar's npm deps in a node image so the final
# image only carries the runtime + the resolved tree (no npm cache,
# no build tools).
FROM node:22-alpine AS sidecar-builder
WORKDIR /sidecar
COPY cmd/yjs-engine/package.json cmd/yjs-engine/package-lock.json ./
RUN npm ci --omit=dev
COPY cmd/yjs-engine/ ./

FROM node:22-alpine
RUN apk add --no-cache ca-certificates
COPY --from=go-builder /relay /usr/local/bin/relay
COPY --from=sidecar-builder /sidecar /usr/local/share/collab-editor/yjs-engine
COPY config/relay.yaml /etc/collab-editor/relay.yaml
EXPOSE 8080 9090
ENTRYPOINT ["relay"]
CMD ["--config", "/etc/collab-editor/relay.yaml"]
