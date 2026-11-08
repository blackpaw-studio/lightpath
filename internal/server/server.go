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
type Config struct {
	Port     int
	Static   fs.FS
	Source   TraceSource
	Validate Validator
	Logger   *slog.Logger
}

type handler struct {
	port     int
	source   TraceSource
	validate Validator
	log      *slog.Logger
}

// New returns the guarded agent handler: static UI on every GET plus /ws.
func New(cfg Config) (http.Handler, error) {
	switch {
	case cfg.Port <= 0 || cfg.Port > 65535:
		return nil, errors.New("server: config needs a valid port")
	case cfg.Source == nil:
		return nil, errors.New("server: config needs a trace source")
	case cfg.Validate == nil:
		return nil, errors.New("server: config needs a target validator")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	h := &handler{port: cfg.Port, source: cfg.Source, validate: cfg.Validate, log: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.Handle("/", Static(cfg.Static))
	return GuardHost(cfg.Port, mux), nil
}
