package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

const (
	readLimit    = 4 << 10 // client messages are tiny; anything bigger is hostile
	writeTimeout = 10 * time.Second
	outBuffer    = 64
)

const (
	msgInvalidTarget = "target must be an IP address or an RFC 1123 hostname"
	msgBadMessage    = "malformed message"
	msgTraceFailed   = "trace failed"
)

func (h *handler) serveWS(w http.ResponseWriter, r *http.Request) {
	if err := CheckUpgrade(r, h.port); err != nil {
		h.log.Warn("ws upgrade rejected", "remote", r.RemoteAddr, "err", err)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Defence in depth behind CheckUpgrade; full origins include the scheme.
		OriginPatterns:  allowedOrigins(h.port),
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return // Accept already wrote the response
	}
	conn.SetReadLimit(readLimit)
	newSession(h, conn).run()
}

type outItem struct {
	ctx context.Context // dropped by the writer once its trace is cancelled
	msg protocol.ServerMsg
}

// session owns one connection: one reader (this goroutine), one writer, and
// at most one live trace.
type session struct {
	h      *handler
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	out    chan outItem
	wg     sync.WaitGroup

	// Touched only by the read loop.
	stopTrace context.CancelFunc
	prevDone  <-chan struct{}
}

func newSession(h *handler, conn *websocket.Conn) *session {
	ctx, cancel := context.WithCancel(context.Background())
	closed := make(chan struct{})
	close(closed)
	return &session{h: h, conn: conn, ctx: ctx, cancel: cancel, out: make(chan outItem, outBuffer), prevDone: closed}
}

func (s *session) run() {
	s.wg.Add(1)
	go s.writeLoop()
	defer func() {
		s.cancel() // tears down the trace and the writer
		s.wg.Wait()
		_ = s.conn.CloseNow()
	}()
	s.readLoop()
}

func (s *session) readLoop() {
	for {
		typ, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			s.reply(protocol.Error{Code: protocol.ErrBadMessage, Message: msgBadMessage})
			continue
		}
		msg, err := protocol.DecodeClient(data)
		if err != nil {
			s.reply(protocol.Error{Code: protocol.ErrBadMessage, Message: msgBadMessage})
			continue
		}
		switch m := msg.(type) {
		case protocol.TraceStart:
			if err := s.h.validate(m.Target); err != nil {
				s.reply(protocol.Error{Code: protocol.ErrInvalidTarget, Message: msgInvalidTarget})
				continue
			}
			s.startTrace(m.Target)
		case protocol.TraceCancel:
			s.cancelTrace()
		}
	}
}

func (s *session) cancelTrace() {
	if s.stopTrace != nil {
		s.stopTrace()
	}
}

// startTrace cancels the live trace and launches a new one that begins only
// after its predecessor has fully returned, so stale events cannot interleave.
func (s *session) startTrace(target string) {
	s.cancelTrace()
	ctx, cancel := context.WithCancel(s.ctx)
	prev, done := s.prevDone, make(chan struct{})
	s.stopTrace, s.prevDone = cancel, done

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer close(done)
		// ctx is deliberately not cancelled on completion: queued events must
		// still be written. It is released by the next start/cancel or teardown.
		<-prev
		if ctx.Err() != nil {
			return
		}
		em := &orderedEmitter{s: s, ctx: ctx}
		err := s.h.source.Trace(ctx, target, em.emit)
		em.flush()
		if err != nil && ctx.Err() == nil {
			s.h.log.Error("trace failed", "err", err)
			s.send(ctx, protocol.Error{Code: protocol.ErrTracerouteFailed, Message: msgTraceFailed})
		}
	}()
}

func (s *session) reply(m protocol.ServerMsg) { s.send(s.ctx, m) }

func (s *session) send(ctx context.Context, m protocol.ServerMsg) {
	select {
	case s.out <- outItem{ctx: ctx, msg: m}:
	case <-ctx.Done():
	}
}

// writeLoop is the only goroutine that writes to the socket.
func (s *session) writeLoop() {
	defer s.wg.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case it := <-s.out:
			if it.ctx.Err() != nil {
				continue
			}
			data, err := json.Marshal(it.msg)
			if err != nil {
				s.h.log.Error("encode event", "err", err)
				continue
			}
			wctx, cancel := context.WithTimeout(s.ctx, writeTimeout)
			err = s.conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				s.cancel()
				return
			}
		}
	}
}

// orderedEmitter holds every event back until trace.started has gone out, so
// the client always sees it first even when enrichment outruns the origin
// lookup.
type orderedEmitter struct {
	s       *session
	ctx     context.Context
	mu      sync.Mutex
	started bool
	pending []protocol.ServerMsg
}

func isTraceStarted(m protocol.ServerMsg) bool {
	switch m.(type) {
	case protocol.TraceStarted, *protocol.TraceStarted:
		return true
	}
	return false
}

func (e *orderedEmitter) emit(m protocol.ServerMsg) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.started && !isTraceStarted(m) {
		e.pending = append(e.pending, m)
		return
	}
	e.s.send(e.ctx, m)
	e.release()
}

// flush releases anything still buffered when the source returns (e.g. it
// failed before trace.started), so errors are never swallowed.
func (e *orderedEmitter) flush() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.release()
	e.started = true
}

func (e *orderedEmitter) release() {
	if e.started {
		return
	}
	e.started = true
	for _, p := range e.pending {
		e.s.send(e.ctx, p)
	}
	e.pending = nil
}
