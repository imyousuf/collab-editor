package yjsengine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// SidecarEngine talks to the Node yjs-engine sidecar (cmd/yjs-engine)
// over a Unix domain socket. The sidecar runs the canonical yjs npm
// package — semantics are dictated by lib0/yjs, not by anything in
// this Go process.
//
// One SidecarEngine instance owns one socket connection. Concurrent
// callers may use the same engine instance (the rpc layer here
// serialises requests and correlates responses by seq) — but
// per-docID serialisation is still required at the Room layer because
// the *sidecar* is not safe for concurrent ops on the same Y.Doc.
//
// On connection drop, all in-flight requests fail with
// ErrSidecarUnavailable. The supervisor (C4) is responsible for
// restarting the sidecar process and calling Reconnect on this
// engine.
type SidecarEngine struct {
	socketPath string

	connMu sync.Mutex
	conn   net.Conn
	closed atomic.Bool

	seq atomic.Uint32

	pendingMu sync.Mutex
	pending   map[uint32]chan frame

	// readLoopDone closes when the goroutine handling inbound frames
	// has exited. Used by Close to wait for cleanup.
	readLoopDone chan struct{}
}

// NewSidecarEngine returns an engine that will dial socketPath on the
// first request. Connect explicitly via Connect to surface dial errors
// early.
func NewSidecarEngine(socketPath string) *SidecarEngine {
	return &SidecarEngine{
		socketPath: socketPath,
		pending:    make(map[uint32]chan frame),
	}
}

// Connect dials the sidecar socket and starts the read loop. Returns
// ErrSidecarUnavailable wrapped with the dial error if the socket
// can't be reached.
func (e *SidecarEngine) Connect(ctx context.Context) error {
	e.connMu.Lock()
	defer e.connMu.Unlock()
	if e.closed.Load() {
		return errors.New("yjsengine: SidecarEngine closed")
	}
	if e.conn != nil {
		return nil
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "unix", e.socketPath)
	if err != nil {
		return fmt.Errorf("%w: dial %s: %v", ErrSidecarUnavailable, e.socketPath, err)
	}
	e.conn = conn
	e.readLoopDone = make(chan struct{})
	go e.readLoop(conn, e.readLoopDone)
	return nil
}

// Shutdown closes the connection to the sidecar and fails any
// outstanding requests with ErrSidecarUnavailable. After Shutdown,
// the SidecarEngine instance must not be reused.
//
// Per-document Close (the Engine interface method) is on the adapter
// returned by AsEngine — see `(*sidecarEngineEngineAdapter).Close`.
func (e *SidecarEngine) Shutdown() error {
	if !e.closed.CompareAndSwap(false, true) {
		return nil
	}
	e.connMu.Lock()
	conn := e.conn
	e.conn = nil
	done := e.readLoopDone
	e.connMu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	if done != nil {
		<-done
	}
	// Fail any still-pending requests.
	e.failAllPending(ErrSidecarUnavailable)
	return nil
}

// readLoop reads frames off the connection and routes them to the
// pending map by seq. Exits on read error or close.
func (e *SidecarEngine) readLoop(conn net.Conn, done chan struct{}) {
	defer close(done)
	for {
		f, err := readFrame(conn)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				e.failAllPending(ErrSidecarUnavailable)
				return
			}
			// Treat any other read error as fatal — fail all pending,
			// drop the connection. Caller (supervisor) will reconnect.
			e.failAllPending(fmt.Errorf("%w: %v", ErrSidecarUnavailable, err))
			return
		}
		e.deliverResponse(f)
	}
}

// deliverResponse hands a frame to the goroutine that initiated the
// matching request. Drops it silently if no waiter (e.g., late
// response after connection drop).
func (e *SidecarEngine) deliverResponse(f frame) {
	e.pendingMu.Lock()
	ch, ok := e.pending[f.seq]
	if ok {
		delete(e.pending, f.seq)
	}
	e.pendingMu.Unlock()
	if !ok {
		return
	}
	// Non-blocking send: ch is buffered with 1 slot.
	select {
	case ch <- f:
	default:
	}
}

// failAllPending notifies every waiting caller of a connection
// failure. After this, the pending map is empty.
func (e *SidecarEngine) failAllPending(err error) {
	e.pendingMu.Lock()
	pending := e.pending
	e.pending = make(map[uint32]chan frame)
	e.pendingMu.Unlock()
	for _, ch := range pending {
		select {
		case ch <- frame{status: statusErr, payload: []byte(err.Error())}:
		default:
		}
	}
}

// call sends a request and waits for the response. ctx cancellation
// removes the request from the pending map but cannot interrupt the
// read loop — the response will be dropped silently if it arrives
// late.
func (e *SidecarEngine) call(ctx context.Context, op byte, payload []byte) ([]byte, error) {
	if e.closed.Load() {
		return nil, ErrSidecarUnavailable
	}
	e.connMu.Lock()
	conn := e.conn
	e.connMu.Unlock()
	if conn == nil {
		return nil, ErrSidecarUnavailable
	}

	seq := e.seq.Add(1)
	ch := make(chan frame, 1)
	e.pendingMu.Lock()
	e.pending[seq] = ch
	e.pendingMu.Unlock()

	defer func() {
		e.pendingMu.Lock()
		delete(e.pending, seq)
		e.pendingMu.Unlock()
	}()

	out := encodeFrame(nil, frame{seq: seq, op: op, status: statusOK, payload: payload})
	if _, err := conn.Write(out); err != nil {
		return nil, fmt.Errorf("%w: write: %v", ErrSidecarUnavailable, err)
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case resp := <-ch:
		if resp.status != statusOK {
			return nil, errFromStatus(resp.payload)
		}
		return resp.payload, nil
	}
}

// ── Engine implementation ────────────────────────────────────────────

func (e *SidecarEngine) Open(ctx context.Context, docID string) error {
	_, err := e.call(ctx, opOpen, writeVarString(nil, docID))
	return err
}

// closeDoc is the per-document close — exposed as `Close` via the
// Engine interface adapter (AsEngine). Kept lowercase here because
// the public process-level shutdown is `Shutdown()`.
func (e *SidecarEngine) closeDoc(ctx context.Context, docID string) error {
	_, err := e.call(ctx, opClose, writeVarString(nil, docID))
	return err
}

func (e *SidecarEngine) BootstrapText(ctx context.Context, docID, name, content string) error {
	if content == "" {
		return nil
	}
	// Bootstrap is encoded on the Go side using ygo (with the pinned
	// serverClientID) and shipped to the sidecar via APPLY_UPDATE.
	// This sidesteps yjs's lack of clientID injection in the Doc
	// constructor and keeps multi-pod seed updates byte-identical.
	//
	// The sidecar treats the resulting bytes as just-another remote
	// update — no clientID handling needed there.
	enc := NewYgoEngine()
	_ = enc.Open(ctx, docID)
	if err := enc.BootstrapText(ctx, docID, name, content); err != nil {
		return err
	}
	state, err := enc.EncodeStateAsUpdate(ctx, docID)
	if err != nil {
		return err
	}
	return e.ApplyUpdate(ctx, docID, state)
}

func (e *SidecarEngine) ApplyUpdate(ctx context.Context, docID string, update []byte) error {
	if len(update) == 0 {
		return nil
	}
	payload := writeVarString(nil, docID)
	payload = append(payload, update...)
	_, err := e.call(ctx, opApplyUpdate, payload)
	return err
}

func (e *SidecarEngine) SyncMessage(ctx context.Context, docID string, syncBody []byte) (byte, []byte, error) {
	payload := writeVarString(nil, docID)
	payload = append(payload, syncBody...)
	resp, err := e.call(ctx, opSyncMessage, payload)
	if err != nil {
		return 0, nil, err
	}
	if len(resp) < 1 {
		return 0, nil, fmt.Errorf("yjsengine: SYNC_MESSAGE response too short (%d bytes)", len(resp))
	}
	return resp[0], resp[1:], nil
}

func (e *SidecarEngine) EncodeStateAsUpdate(ctx context.Context, docID string) ([]byte, error) {
	return e.call(ctx, opEncodeState, writeVarString(nil, docID))
}

func (e *SidecarEngine) EncodeStateVector(ctx context.Context, docID string) ([]byte, error) {
	return e.call(ctx, opEncodeSV, writeVarString(nil, docID))
}

func (e *SidecarEngine) GetText(ctx context.Context, docID, name string) (string, error) {
	payload := writeVarString(nil, docID)
	payload = writeVarString(payload, name)
	resp, err := e.call(ctx, opGetText, payload)
	if err != nil {
		return "", err
	}
	return string(resp), nil
}

// Ping is a connection-health probe used by the supervisor.
func (e *SidecarEngine) Ping(ctx context.Context) error {
	_, err := e.call(ctx, opPing, nil)
	return err
}

// compile-time check.
var _ Engine = (*sidecarEngineEngineAdapter)(nil)

// sidecarEngineEngineAdapter exists only to satisfy the Engine
// interface's `Close(ctx, docID) error` method without colliding with
// SidecarEngine's process-level Close() error. The adapter forwards
// per-doc Close to CloseDoc.
//
// Callers should construct via AsEngine().
type sidecarEngineEngineAdapter struct {
	*SidecarEngine
}

func (a *sidecarEngineEngineAdapter) Close(ctx context.Context, docID string) error {
	return a.SidecarEngine.closeDoc(ctx, docID)
}

// AsEngine returns an Engine view of the SidecarEngine. Use this when
// passing to code that expects the interface; keep the *SidecarEngine
// handle if you need access to the process-level Close() and Connect()
// methods.
func (e *SidecarEngine) AsEngine() Engine {
	return &sidecarEngineEngineAdapter{SidecarEngine: e}
}
