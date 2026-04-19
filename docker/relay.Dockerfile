FROM golang:1.26-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /relay ./cmd/relay

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /relay /usr/local/bin/relay
COPY config/relay.yaml /etc/collab-editor/relay.yaml
EXPOSE 8080 9090
ENTRYPOINT ["relay"]
CMD ["--config", "/etc/collab-editor/relay.yaml"]
