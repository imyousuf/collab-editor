package yjsengine_test

// Sidecar contract tests. Spawns the real Node sidecar (cmd/yjs-engine)
// as a child process listening on a temp Unix socket, dials it from Go,
// and runs the same contract tests as YgoEngine. Test is skipped if
// `node` is not on PATH or the sidecar's node_modules aren't installed.
//
// This is the first cross-implementation guard against wire-format
// divergence between ygo (used by YgoEngine + the SDK) and lib0/yjs
// (used by SidecarEngine). Any test that passes for ygo but fails for
// the sidecar exposes a bug.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/internal/relay/yjsengine"
)

// init prepends the sidecar factory to the contract test list when the
// runtime prerequisites are present. If anything is missing, the
// sidecar arm of the contract tests skips with a clear message.
func init() {
	registerSidecarFactory()
}

// registerSidecarFactory mutates the package-level engine factory list
// added by engine_test.go. Done in init() so the contract tests pick
// it up automatically.
func registerSidecarFactory() {
	addEngineFactory(engineFactory{
		name: "sidecar",
		make: func(t *testing.T) yjsengine.Engine {
			t.Helper()
			eng, cleanup, err := startSidecar(t)
			if err != nil {
				t.Skipf("sidecar unavailable: %v", err)
			}
			t.Cleanup(cleanup)
			return eng
		},
	})
}

// repoRoot walks up from this test file's working dir until it finds
// the cmd/yjs-engine directory. We can't rely on `go test` cwd being
// the package dir (it is by default, but tests sometimes run from
// elsewhere via `go test ./...`).
func repoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "cmd", "yjs-engine", "index.js")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("cmd/yjs-engine not found")
		}
		dir = parent
	}
}

// startSidecar boots a Node child running the sidecar against a temp
// Unix socket and returns a connected SidecarEngine adapted to the
// Engine interface. Cleanup tears down the process and removes the
// socket file.
func startSidecar(t *testing.T) (yjsengine.Engine, func(), error) {
	t.Helper()

	if _, err := exec.LookPath("node"); err != nil {
		return nil, nil, fmt.Errorf("node not on PATH: %w", err)
	}
	root, err := repoRoot()
	if err != nil {
		return nil, nil, err
	}
	sidecarDir := filepath.Join(root, "cmd", "yjs-engine")
	if _, err := os.Stat(filepath.Join(sidecarDir, "node_modules", "yjs")); err != nil {
		return nil, nil, fmt.Errorf("sidecar node_modules missing — run `npm install` in %s", sidecarDir)
	}

	// Use a per-test socket path so parallel tests don't collide.
	sock := filepath.Join(t.TempDir(), "yjs-engine.sock")

	ctx, cancel := context.WithCancel(context.Background())

	cmd := exec.CommandContext(ctx, "node", "index.js")
	cmd.Dir = sidecarDir
	cmd.Env = append(os.Environ(), "YJS_ENGINE_SOCK="+sock)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, nil, err
	}
	cmd.Stderr = os.Stderr // surface sidecar errors in test output

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, nil, fmt.Errorf("start sidecar: %w", err)
	}

	// Wait for the readiness line on stdout (≤2 s).
	readyCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "yjs-engine ready") {
				readyCh <- nil
				return
			}
		}
		readyCh <- fmt.Errorf("sidecar exited before ready (stdout: %v)", scanner.Err())
	}()

	select {
	case err := <-readyCh:
		if err != nil {
			cancel()
			_ = cmd.Wait()
			return nil, nil, err
		}
	case <-time.After(5 * time.Second):
		cancel()
		_ = cmd.Wait()
		return nil, nil, fmt.Errorf("sidecar did not become ready within 5s")
	}

	eng := yjsengine.NewSidecarEngine(sock)
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer dialCancel()
	if err := eng.Connect(dialCtx); err != nil {
		cancel()
		_ = cmd.Wait()
		return nil, nil, fmt.Errorf("dial sidecar: %w", err)
	}

	cleanup := func() {
		_ = eng.Shutdown()
		cancel() // signals sidecar via context cancellation → SIGKILL
		// Drain stdout to avoid blocking the goroutine.
		go func() { _, _ = bufio.NewReader(stdout).ReadString(0) }()
		_ = cmd.Wait()
		_ = os.Remove(sock)
	}
	return eng.AsEngine(), cleanup, nil
}
