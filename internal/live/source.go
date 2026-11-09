// Package live composes the real trace pipeline: target validation, the
// traceroute runner and hop enrichment, behind the server's TraceSource shape.
package live

import (
	"context"
	"errors"
	"net/netip"
	"sync"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"github.com/blackpaw-studio/lightpath/internal/reach"
	"github.com/blackpaw-studio/lightpath/internal/target"
	"github.com/blackpaw-studio/lightpath/internal/trace"
)

// Runner starts traceroute and streams its events (trace.Runner does).
type Runner interface {
	Run(ctx context.Context, name string, args []string) <-chan trace.Event
}

// Enricher emits a hop and its later hop.updates (*enrich.Enricher does).
// After ctx is cancelled and wait has returned, it must never emit again.
type Enricher interface {
	Enrich(ctx context.Context, hop protocol.Hop, emit func(protocol.ServerMsg)) (wait func())
}

// OriginSource supplies the trace origin (*enrich.OriginResolver does); Get
// waits a bounded time for an outstanding fetch.
type OriginSource interface {
	Get(ctx context.Context) protocol.Origin
}

// Reacher checks whether the destination accepts TCP connections
// (reach.Checker does). It must return promptly once ctx is cancelled.
type Reacher interface {
	Check(ctx context.Context, ip netip.Addr) reach.Result
}

// Config wires a Source. Command maps a validated target to an argv, e.g.
// target.CommandFor bound to runtime.GOOS. Validate defaults to target.Validate.
type Config struct {
	Runner   Runner
	Command  func(target string) (name string, args []string)
	Enricher Enricher
	Origin   OriginSource
	Reach    Reacher
	// Clock times the destination grace period (enrich.RealClock in production).
	Clock    reach.Clock
	Validate func(target string) error
}

// Source runs live traces. It is safe for concurrent traces; the enrichment
// clients behind it are meant to be shared by the whole agent process.
type Source struct{ cfg Config }

// New returns a Source, or an error if a dependency is missing.
func New(cfg Config) (*Source, error) {
	if cfg.Runner == nil || cfg.Command == nil || cfg.Enricher == nil || cfg.Origin == nil || cfg.Reach == nil || cfg.Clock == nil {
		return nil, errors.New("live: config needs a runner, command, enricher, origin, reach checker and clock")
	}
	if cfg.Validate == nil {
		cfg.Validate = target.Validate
	}
	return &Source{cfg: cfg}, nil
}

const msgInvalidTarget = "target must be an IP address or an RFC 1123 hostname"

// Trace runs one traceroute to tgt. It emits trace.started (with the origin)
// before any hop, each hop and its enrichment updates, then trace.done or an
// error once every hop's enrichment has finished. When ctx is cancelled it
// stops the process, cancels enrichment and returns only after every
// enrichment goroutine has finished, so nothing from this trace is emitted
// after Trace returns.
func (s *Source) Trace(ctx context.Context, tgt string, emit func(protocol.ServerMsg)) error {
	if err := s.cfg.Validate(tgt); err != nil {
		emit(protocol.Error{Code: protocol.ErrInvalidTarget, Message: msgInvalidTarget})
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	run := &traceRun{src: s, ctx: ctx, target: tgt, emit: emit}
	defer run.drain(cancel)

	name, args := s.cfg.Command(tgt)
	for ev := range s.cfg.Runner.Run(ctx, name, args) {
		run.handle(ev)
	}
	return ctx.Err()
}

// traceRun is the state of one Trace call; only the Trace goroutine touches
// it, apart from the wait funcs it collects.
type traceRun struct {
	src     *Source
	ctx     context.Context
	target  string
	emit    func(protocol.ServerMsg)
	started bool
	waits   []func()
	dest    *destRun
}

func (r *traceRun) handle(ev trace.Event) {
	switch e := ev.(type) {
	case trace.Header:
		r.start(e.ResolvedIP)
		r.startDest(e.ResolvedIP)
	case trace.HopEvent:
		r.start("")
		hop := e.Hop
		if !hop.GeoSource.Valid() {
			hop.GeoSource = protocol.GeoEstimated // the parser leaves it empty
		}
		r.waits = append(r.waits, r.src.cfg.Enricher.Enrich(r.ctx, hop, r.emit))
	case trace.Done:
		r.waitAll()
		done := protocol.TraceDone{Reached: e.Reached, Destination: r.destWait(true)}
		if e.Reason.Valid() {
			done.Reason = &e.Reason
		}
		r.emitIfLive(done)
	case trace.ErrorEvent:
		r.waitAll()
		r.destWait(false) // an error has no use for the destination: don't delay it
		r.emitIfLive(protocol.Error{Code: e.Code, Message: e.Message})
	}
}

// start emits trace.started once, before the first hop.
func (r *traceRun) start(resolvedIP string) {
	if r.started {
		return
	}
	r.started = true
	var resolved *string
	if resolvedIP != "" {
		resolved = &resolvedIP
	}
	r.emit(protocol.TraceStarted{Target: r.target, ResolvedIP: resolved, Origin: r.src.cfg.Origin.Get(r.ctx)})
}

func (r *traceRun) emitIfLive(m protocol.ServerMsg) {
	if r.ctx.Err() == nil {
		r.emit(m)
	}
}

// waitAll blocks until every hop's enrichment has finished (each lookup is
// individually time-bounded), so the terminal event follows every update.
func (r *traceRun) waitAll() {
	var wg sync.WaitGroup
	for _, w := range r.waits {
		wg.Go(w)
	}
	wg.Wait()
	r.waits = nil
}

// drain cancels the trace and joins all enrichment and the destination work
// before Trace returns.
func (r *traceRun) drain(cancel context.CancelFunc) {
	cancel()
	r.waitAll()
	r.destWait(false)
}
