.PHONY: build relay provider test test-fast lint fmt vet proto docker-up docker-down docker-build clean test-e2e

GO := go
BIN_DIR := bin

build: relay provider

relay:
	$(GO) build -o $(BIN_DIR)/relay ./cmd/relay

provider:
	$(GO) build -o $(BIN_DIR)/provider ./cmd/demo-provider

test:
	$(GO) test -v -race -count=1 ./...

test-fast:
	$(GO) test -count=1 ./...

lint:
	golangci-lint run ./...

vet:
	$(GO) vet ./...

fmt:
	gofmt -w .

proto:
	buf generate

docker-build:
	docker compose build

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

clean:
	rm -rf $(BIN_DIR)/

test-e2e:
	cd examples/basic && docker compose up -d --wait
	atr tests/e2e/collaborative-editing.test.txt
	atr tests/e2e/mode-switching.test.txt
	atr tests/e2e/persistence.test.txt
	atr tests/e2e/readonly-mode.test.txt
	atr tests/e2e/connection-status.test.txt
	atr tests/e2e/format-markdown.test.txt
	atr tests/e2e/format-html.test.txt
	atr tests/e2e/format-python.test.txt
	atr tests/e2e/format-reactjs.test.txt
	atr tests/e2e/react-wrapper.test.txt
