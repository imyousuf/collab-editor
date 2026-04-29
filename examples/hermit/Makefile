# Hermit — local-only desktop file editor built on <multi-editor>.
#
# Targets:
#   make            — build the desktop binary (default)
#   make dev        — run in dev mode with hot reload
#   make run        — build, then launch the binary
#   make component  — (re)build the upstream <multi-editor> package
#   make clean      — remove build artefacts and node_modules
#   make help       — print this list
#
# Output: build/bin/hermit (or hermit.exe on Windows)

# Robustness flags:
#   .DELETE_ON_ERROR    — drop half-written outputs when a recipe fails
#   .SUFFIXES (empty)   — disable legacy implicit suffix rules
.DELETE_ON_ERROR:
.SUFFIXES:

REPO_ROOT      := $(abspath $(CURDIR)/../..)
COMPONENT_DIR  := $(REPO_ROOT)/frontend
COMPONENT_DIST := $(COMPONENT_DIR)/dist/multi-editor.js

# Track every component source file so the dist rebuilds when any of
# them change. Excludes __tests__ since those don't affect the bundle.
COMPONENT_SOURCES := $(shell find $(COMPONENT_DIR)/src -type f -name '*.ts' \
                       ! -path '*/__tests__/*' 2>/dev/null)
COMPONENT_CONFIGS := $(wildcard $(COMPONENT_DIR)/package.json) \
                     $(wildcard $(COMPONENT_DIR)/package-lock.json) \
                     $(wildcard $(COMPONENT_DIR)/vite.config.ts) \
                     $(wildcard $(COMPONENT_DIR)/tsconfig.json)

ifeq ($(OS),Windows_NT)
BIN := build/bin/hermit.exe
UNAME_S := Windows
else
BIN := build/bin/hermit
UNAME_S := $(shell uname -s 2>/dev/null)
endif

# On Linux, Wails defaults to webkit2gtk-4.0. Distros that only ship
# 4.1 (Ubuntu 24.04+, Fedora 39+) need the webkit2_41 build tag. The
# 4.0 check is gated on pkg-config existing first so a missing
# pkg-config doesn't silently leave us tagless.
WAILS_TAGS :=
ifeq ($(UNAME_S),Linux)
ifeq ($(shell command -v pkg-config >/dev/null 2>&1 && echo ok),ok)
ifneq ($(shell pkg-config --exists webkit2gtk-4.0 2>/dev/null && echo ok),ok)
ifeq ($(shell pkg-config --exists webkit2gtk-4.1 2>/dev/null && echo ok),ok)
WAILS_TAGS := -tags webkit2_41
endif
endif
endif
endif

.PHONY: all build dev run component clean check help
.DEFAULT_GOAL := all

all: build

help:
	@echo "Hermit — Wails desktop editor."
	@echo
	@echo "  make            build the desktop binary (default)"
	@echo "  make dev        run in dev mode with hot reload"
	@echo "  make run        build, then launch the binary"
	@echo "  make component  (re)build the upstream <multi-editor> package"
	@echo "  make clean      remove build artefacts and node_modules"
	@echo "  make help       this list"

# Verify every tool the build needs. Fails fast with an actionable hint.
check:
	@command -v wails >/dev/null 2>&1 || { \
		echo "wails CLI not found."; \
		echo "Install: go install github.com/wailsapp/wails/v2/cmd/wails@latest"; \
		exit 1; }
	@command -v go   >/dev/null 2>&1 || { echo "go not found";   exit 1; }
	@command -v node >/dev/null 2>&1 || { echo "node not found"; exit 1; }
	@command -v npm  >/dev/null 2>&1 || { echo "npm not found";  exit 1; }
	@if [ "$(UNAME_S)" = "Linux" ]; then \
		command -v pkg-config >/dev/null 2>&1 || { \
			echo "pkg-config not found (apt: pkg-config)"; exit 1; }; \
		pkg-config --exists gtk+-3.0 || { \
			echo "libgtk-3-dev not found (apt: libgtk-3-dev)"; exit 1; }; \
		if ! pkg-config --exists webkit2gtk-4.0 \
		     && ! pkg-config --exists webkit2gtk-4.1; then \
			echo "webkit2gtk dev package not found."; \
			echo "  Ubuntu 22.04: sudo apt install libwebkit2gtk-4.0-dev"; \
			echo "  Ubuntu 24.04: sudo apt install libwebkit2gtk-4.1-dev"; \
			exit 1; \
		fi; \
	fi

# (Re)build @imyousuf/collab-editor whenever its sources change. The
# example links it via file:../../../frontend, so a stale dist means a
# stale binary.
$(COMPONENT_DIST): $(COMPONENT_SOURCES) $(COMPONENT_CONFIGS)
	cd $(COMPONENT_DIR) && npm install && npm run build

component: $(COMPONENT_DIST)

build: check $(COMPONENT_DIST)
	wails build $(WAILS_TAGS)
	@test -x $(BIN) || { echo "wails build did not produce $(BIN)"; exit 1; }
	@echo
	@echo "Built $(BIN)"

dev: check $(COMPONENT_DIST)
	wails dev $(WAILS_TAGS)

run: build
	./$(BIN)

clean:
	rm -rf build frontend/dist frontend/node_modules
