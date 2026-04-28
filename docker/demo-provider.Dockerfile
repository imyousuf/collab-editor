FROM golang:1.26-alpine AS builder
WORKDIR /build
# Mirrors relay.Dockerfile: third_party/ygo is the local patched ygo fork
# referenced by `replace` in go.mod. Must be on disk before `go mod download`.
COPY go.mod go.sum ./
COPY third_party ./third_party
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /provider ./cmd/demo-provider

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /provider /usr/local/bin/provider
COPY config/provider.yaml /etc/collab-editor/provider.yaml
COPY docker/seed-entrypoint.sh /usr/local/bin/seed-entrypoint.sh
RUN chmod +x /usr/local/bin/seed-entrypoint.sh && mkdir -p /data/documents
EXPOSE 8081
ENTRYPOINT ["seed-entrypoint.sh"]
CMD ["--config", "/etc/collab-editor/provider.yaml"]
