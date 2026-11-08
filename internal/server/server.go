package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"io/fs"
)

// Validator vets a client-supplied trace target before anything runs.
type Validator func(target string) error

// TraceSource runs one trace and streams its events through emit. It must
// return promptly once ctx is cancelled, and may call emit concurrently.
// Events may arrive before trace.started; the session reorders them. A source
// reports expected failures as protocol.Error events; a non-nil error return
// that is not a cancellation is reported as traceroute_failed.
type TraceSource interface {
	Trace(ctx context.Context, target string, emit func(protocol.ServerMsg)) error
}

// Config wires the server. Port is the port the listener actually bound; it
// feeds the Host/Origin allowlists. Static may be nil (placeholder only).
//
// Context is the app lifetime: cancelling it closes every WebSocket and
// cancels every trace (nil means never). MaxTraces and MaxConns bound the
// whole server rather than one socket; zero selects the default.
type Config struct {
	Port      int
	Static    fs.FS
	Source    TraceSource
	Validate  Validator
	Logger    *slog.Logger
	Context   context.Context
	MaxTraces int
	MaxConns  int
}

// Defaults for Config.MaxTraces and Config.MaxConns.
const (
	DefaultMaxTraces = 4
	DefaultMaxConns  = 16
)

type handler struct {
	port     int
	source   TraceSource
	validate Validator
	log      *slog.Logger
	ctx      context.Context
	traces   *limiter // server-wide concurrent traces
	conns    *limiter // open sockets
	life     *lifecycle
}

// Server is the guarded agent handler. After its Config.Context is cancelled,
// Wait blocks until every session, and so every trace, has fully returned.
type Server struct {
	http.Handler
	life *lifecycle
}

// Wait returns once all sessions have ended and refuses new ones; it gives up
// with ctx's error if they do not end in time.
func (s *Server) Wait(ctx context.Context) error { return s.life.wait(ctx) }

// New returns the guarded agent handler: static UI on every GET plus /ws.
func New(cfg Config) (*Server, error) {
	switch {
	case cfg.Port <= 0 || cfg.Port > 65535:
		return nil, errors.New("server: config needs a valid port")
	case cfg.Source == nil:
		return nil, errors.New("server: config needs a trace source")
	case cfg.Validate == nil:
		return nil, errors.New("server: config needs a target validator")
	case cfg.MaxTraces < 0 || cfg.MaxConns < 0:
		return nil, errors.New("server: limits must not be negative")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	ctx := cfg.Context
	if ctx == nil {
		ctx = context.Background()
	}
	h := &handler{
		port: cfg.Port, source: cfg.Source, validate: cfg.Validate, log: logger, ctx: ctx,
		traces: newLimiter(orDefault(cfg.MaxTraces, DefaultMaxTraces)),
		conns:  newLimiter(orDefault(cfg.MaxConns, DefaultMaxConns)),
		life:   &lifecycle{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.Handle("/", Static(cfg.Static))
	return &Server{Handler: GuardHost(cfg.Port, mux), life: h.life}, nil
}

func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}
