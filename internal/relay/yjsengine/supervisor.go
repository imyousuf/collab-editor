package yjsengine

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Supervisor owns the lifecycle of the Node yjs-engine sidecar:
// spawn, readiness handshake, log forwarding, restart-on-crash with
// exponential backoff, and clean shutdown. Callers get a stable
// Engine via Engine() that survives sidecar restarts.
//
// The supervisor is process-scoped — one per relay instance. Multiple
// docs share the same sidecar (and therefore the same socket
// connection); per-doc serialisation is the caller's responsibility
// (Room.ydocMu).
//
// Restart policy: the supervisor restarts the sidecar on crash with
// exponential backoff capped at MaxBackoff. If restarts exceed
// MaxRestartsPerMinute the supervisor gives up and Engine() calls
// fail with ErrSidecarUnavailable until a manual recovery (e.g.
// container restart). After each successful restart, registered
// OnReconnect hooks fire so callers (Rooms) can re-bootstrap state.
type Supervisor struct {
	cfg    SupervisorConfig
	logger *slog.Logger

	// Owned process + engine. Replaced atomically on restart;
	// readers go through Engine() / current().
	mu      sync.RWMutex
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	engine  *SidecarEngine
	exited  chan struct{} // closes when the current process exits
	stopped atomic.Bool

	// onReconnect hooks run after every successful (re)start once the
	// sidecar is ready. Caller is responsible for idempotency. C5
	// wires Room re-bootstrap here.
	hookMu     sync.Mutex
	onReconnectHooks []func(ctx context.Context) error

	// Restart-rate limiter.
	restartMu     sync.Mutex
	restartTimes  []time.Time
}

// SupervisorConfig wraps the inputs the supervisor needs. All fields
// have sane defaults filled in by Start.
type SupervisorConfig struct {
	NodeBin     string        // path to `node` (default "node")
	SidecarDir  string        // dir containing the sidecar's package.json
	SocketPath  string        // unix socket path (default $TMPDIR/yjs-engine-$pid.sock)
	ReadyTimeout time.Duration // wait for ready line (default 10s)

	InitialBackoff       time.Duration // (default 200ms)
	MaxBackoff           time.Duration // (default 10s)
	MaxRestartsPerMinute int           // (default 10; 0 disables rate limit)

	Logger *slog.Logger // (default slog.Default())
}

// StartSupervisor spawns the sidecar, dials it, and returns a
// Supervisor that will restart on crash. The returned Supervisor is
// usable immediately. Block until the first sidecar process is ready
// (or ReadyTimeout elapses).
func StartSupervisor(ctx context.Context, cfg SupervisorConfig) (*Supervisor, error) {
	if cfg.NodeBin == "" {
		cfg.NodeBin = "node"
	}
	if cfg.ReadyTimeout == 0 {
		cfg.ReadyTimeout = 10 * time.Second
	}
	if cfg.InitialBackoff == 0 {
		cfg.InitialBackoff = 200 * time.Millisecond
	}
	if cfg.MaxBackoff == 0 {
		cfg.MaxBackoff = 10 * time.Second
	}
	if cfg.SocketPath == "" {
		cfg.SocketPath = filepath.Join(os.TempDir(), fmt.Sprintf("yjs-engine-%d.sock", os.Getpid()))
	}
	if cfg.SidecarDir == "" {
		return nil, errors.New("yjsengine: SupervisorConfig.SidecarDir is required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	s := &Supervisor{
		cfg:    cfg,
		logger: cfg.Logger.With("component", "yjs-sidecar"),
	}

	if err := s.startOnce(ctx); err != nil {
		return nil, err
	}
	go s.watchAndRestart()
	return s, nil
}

// Engine returns an Engine that proxies through the supervisor and
// remains valid across restarts. Each call resolves the current
// SidecarEngine; if the sidecar is mid-restart, calls return
// ErrSidecarUnavailable.
func (s *Supervisor) Engine() Engine {
	return &supervisedEngine{sup: s}
}

// OnReconnect registers a hook to run after every (re)start once the
// sidecar is ready. The hook runs in its own goroutine; errors are
// logged but don't abort the supervisor. Hooks must be idempotent
// (they fire on the very first start as well as on restarts).
func (s *Supervisor) OnReconnect(fn func(ctx context.Context) error) {
	s.hookMu.Lock()
	s.onReconnectHooks = append(s.onReconnectHooks, fn)
	s.hookMu.Unlock()
}

// Shutdown stops the sidecar gracefully. SIGTERM, then SIGKILL after
// 5 seconds. Idempotent.
func (s *Supervisor) Shutdown(ctx context.Context) error {
	if !s.stopped.CompareAndSwap(false, true) {
		return nil
	}
	s.mu.Lock()
	cancel := s.cancel
	cmd := s.cmd
	engine := s.engine
	exited := s.exited
	s.mu.Unlock()

	if engine != nil {
		_ = engine.Shutdown()
	}
	if cancel != nil {
		cancel() // cancels the cmd's context → SIGKILL after grace
	}
	if cmd != nil && cmd.Process != nil {
		// Try a graceful SIGTERM first; cancel above will SIGKILL on grace.
		_ = cmd.Process.Signal(os.Interrupt)
	}
	if exited != nil {
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
		}
	}
	_ = os.Remove(s.cfg.SocketPath)
	return nil
}

// startOnce spawns the sidecar, waits for the ready line, dials, and
// fires onReconnect hooks. Holds s.mu while replacing state.
func (s *Supervisor) startOnce(ctx context.Context) error {
	if s.stopped.Load() {
		return errors.New("yjsengine: supervisor stopped")
	}
	// Fresh socket — clean any stale file.
	_ = os.Remove(s.cfg.SocketPath)

	procCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(procCtx, s.cfg.NodeBin, "index.js")
	cmd.Dir = s.cfg.SidecarDir
	cmd.Env = append(os.Environ(), "YJS_ENGINE_SOCK="+s.cfg.SocketPath)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("yjsengine: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("yjsengine: stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("yjsengine: start sidecar: %w", err)
	}
	s.logger.Info("sidecar started", "pid", cmd.Process.Pid, "sock", s.cfg.SocketPath)

	// Forward stderr through slog as warnings (sidecar shutdown lines
	// also land on stderr in the index.js implementation).
	go forwardLines(stderr, s.logger, slog.LevelWarn)

	// Read stdout until the ready line; subsequent lines forward as info.
	readyCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		ready := false
		for scanner.Scan() {
			line := scanner.Text()
			if !ready && strings.HasPrefix(line, "yjs-engine ready") {
				ready = true
				readyCh <- nil
				continue
			}
			s.logger.Info(line)
		}
		if !ready {
			readyCh <- fmt.Errorf("sidecar exited before ready (stdout closed)")
		}
	}()

	select {
	case err := <-readyCh:
		if err != nil {
			cancel()
			_ = cmd.Wait()
			return err
		}
	case <-ctx.Done():
		cancel()
		_ = cmd.Wait()
		return ctx.Err()
	case <-time.After(s.cfg.ReadyTimeout):
		cancel()
		_ = cmd.Wait()
		return fmt.Errorf("sidecar did not become ready in %s", s.cfg.ReadyTimeout)
	}

	engine := NewSidecarEngine(s.cfg.SocketPath)
	dialCtx, dialCancel := context.WithTimeout(ctx, 5*time.Second)
	defer dialCancel()
	if err := engine.Connect(dialCtx); err != nil {
		cancel()
		_ = cmd.Wait()
		return fmt.Errorf("yjsengine: dial sidecar: %w", err)
	}

	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()

	s.mu.Lock()
	s.cmd = cmd
	s.cancel = cancel
	s.engine = engine
	s.exited = exited
	s.mu.Unlock()

	// Fire reconnect hooks. Each runs in its own goroutine so a slow
	// hook can't block other hooks or future restarts.
	s.hookMu.Lock()
	hooks := append([]func(context.Context) error(nil), s.onReconnectHooks...)
	s.hookMu.Unlock()
	for _, hook := range hooks {
		go func(fn func(context.Context) error) {
			if err := fn(ctx); err != nil {
				s.logger.Warn("reconnect hook failed", "err", err)
			}
		}(hook)
	}
	return nil
}

// watchAndRestart blocks on the current process exit and restarts the
// sidecar on crash. Honours MaxRestartsPerMinute — once exceeded, the
// supervisor stops trying.
func (s *Supervisor) watchAndRestart() {
	for {
		s.mu.RLock()
		exited := s.exited
		s.mu.RUnlock()
		if exited == nil {
			return
		}
		<-exited
		if s.stopped.Load() {
			return
		}

		s.logger.Warn("sidecar exited; restarting")

		// Rate limit.
		if !s.recordRestart() {
			s.logger.Error("sidecar restart rate limit exceeded — giving up",
				"max_per_minute", s.cfg.MaxRestartsPerMinute)
			s.mu.Lock()
			if s.engine != nil {
				_ = s.engine.Shutdown()
			}
			s.engine = nil
			s.mu.Unlock()
			return
		}

		backoff := s.cfg.InitialBackoff
		for {
			if s.stopped.Load() {
				return
			}
			time.Sleep(backoff)
			ctx, cancel := context.WithTimeout(context.Background(), s.cfg.ReadyTimeout)
			err := s.startOnce(ctx)
			cancel()
			if err == nil {
				s.logger.Info("sidecar restart succeeded")
				break
			}
			s.logger.Warn("sidecar restart failed; backing off", "err", err, "next_backoff", backoff)
			backoff *= 2
			if backoff > s.cfg.MaxBackoff {
				backoff = s.cfg.MaxBackoff
			}
		}
	}
}

// recordRestart trims old entries (>1 minute) and appends now.
// Returns false if the rate limit is exceeded.
func (s *Supervisor) recordRestart() bool {
	s.restartMu.Lock()
	defer s.restartMu.Unlock()
	if s.cfg.MaxRestartsPerMinute <= 0 {
		return true
	}
	cutoff := time.Now().Add(-time.Minute)
	kept := s.restartTimes[:0]
	for _, t := range s.restartTimes {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	s.restartTimes = kept
	if len(s.restartTimes) >= s.cfg.MaxRestartsPerMinute {
		return false
	}
	s.restartTimes = append(s.restartTimes, time.Now())
	return true
}

// current returns the live SidecarEngine, or nil if the sidecar is
// unavailable (mid-restart, shut down, or rate-limited).
func (s *Supervisor) current() *SidecarEngine {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.engine
}

// forwardLines reads lines from r and writes them to logger at
// `level`. Used for the sidecar's stderr.
func forwardLines(r io.ReadCloser, logger *slog.Logger, level slog.Level) {
	defer r.Close()
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		logger.Log(context.Background(), level, scanner.Text())
	}
}

// supervisedEngine wraps a Supervisor and implements the Engine
// interface by routing each call to the current SidecarEngine. If
// the current engine is nil (mid-restart), calls fail with
// ErrSidecarUnavailable. A future enhancement could add a short
// retry-on-restart window; for now we return immediately so the
// caller (Room) can decide.
type supervisedEngine struct {
	sup *Supervisor
}

func (s *supervisedEngine) Open(ctx context.Context, docID string) error {
	eng := s.sup.current()
	if eng == nil {
		return ErrSidecarUnavailable
	}
	return eng.Open(ctx, docID)
}

func (s *supervisedEngine) Close(ctx context.Context, docID string) error {
	eng := s.sup.current()
	if eng == nil {
		return ErrSidecarUnavailable
	}
	return eng.closeDoc(ctx, docID)
}

func (s *supervisedEngine) BootstrapText(ctx context.Context, docID, name, content string) error {
	eng := s.sup.current()
	if eng == nil {
		return ErrSidecarUnavailable
	}
	return eng.BootstrapText(ctx, docID, name, content)
}

func (s *supervisedEngine) ApplyUpdate(ctx context.Context, docID string, update []byte) error {
	eng := s.sup.current()
	if eng == nil {
		return ErrSidecarUnavailable
	}
	return eng.ApplyUpdate(ctx, docID, update)
}

func (s *supervisedEngine) SyncMessage(ctx context.Context, docID string, syncBody []byte) (byte, []byte, error) {
	eng := s.sup.current()
	if eng == nil {
		return 0, nil, ErrSidecarUnavailable
	}
	return eng.SyncMessage(ctx, docID, syncBody)
}

func (s *supervisedEngine) EncodeStateAsUpdate(ctx context.Context, docID string) ([]byte, error) {
	eng := s.sup.current()
	if eng == nil {
		return nil, ErrSidecarUnavailable
	}
	return eng.EncodeStateAsUpdate(ctx, docID)
}

func (s *supervisedEngine) EncodeStateVector(ctx context.Context, docID string) ([]byte, error) {
	eng := s.sup.current()
	if eng == nil {
		return nil, ErrSidecarUnavailable
	}
	return eng.EncodeStateVector(ctx, docID)
}

func (s *supervisedEngine) GetText(ctx context.Context, docID, name string) (string, error) {
	eng := s.sup.current()
	if eng == nil {
		return "", ErrSidecarUnavailable
	}
	return eng.GetText(ctx, docID, name)
}

// compile-time check.
var _ Engine = (*supervisedEngine)(nil)
