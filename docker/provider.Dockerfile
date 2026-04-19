FROM golang:1.26-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /provider ./cmd/provider

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /provider /usr/local/bin/provider
COPY config/provider.yaml /etc/collab-editor/provider.yaml
RUN mkdir -p /data/documents
EXPOSE 8081
ENTRYPOINT ["provider"]
CMD ["--config", "/etc/collab-editor/provider.yaml"]
