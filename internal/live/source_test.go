package live

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"github.com/blackpaw-studio/lightpath/internal/trace"
)

const testTimeout = 5 * time.Second // bounds a hung test only

// fakeRunner replays scripted events; with hold set it keeps the channel
// open until ctx is cancelled, like a traceroute still running.
type fakeRunner struct {
	events []trace.Event
	hold   bool

	mu    sync.Mutex
	calls [][]string
}

func (r *fakeRunner) Run(ctx context.Context, name string, args []string) <-chan trace.Event {
	r.mu.Lock()
	r.calls = append(r.calls, append([]string{name}, args...))
	r.mu.Unlock()
	out := make(chan trace.Event)
	go func() {
		defer close(out)
		for _, ev := range r.events {
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
		if r.hold {
			<-ctx.Done()
		}
	}()
	return out
}

// fakeEnricher emits the hop, then one hop.update from a goroutine that
// waits for gate (or ctx) and honours ctx like the real enricher.
type fakeEnricher struct {
	gate chan struct{} // nil = no gate

	mu   sync.Mutex
	hops []protocol.Hop
}

func (e *fakeEnricher) Enrich(ctx context.Context, hop protocol.Hop, emit func(protocol.ServerMsg)) func() {
	e.mu.Lock()
	e.hops = append(e.hops, hop)
	e.mu.Unlock()
	emit(hop)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if e.gate != nil {
			select {
			case <-e.gate:
			case <-ctx.Done():
				return
			}
		}
		if ctx.Err() == nil {
			u, _ := protocol.NewHopUpdate(hop.TTL, map[string]any{"host": "enriched"})
			emit(u)
		}
	}()
	return func() { <-done }
}

type fakeOrigin struct{ o protocol.Origin }

func (f fakeOrigin) Get(context.Context) protocol.Origin { return f.o }

type sink struct {
	mu     sync.Mutex
	msgs   []protocol.ServerMsg
	notify chan struct{} // optional: signalled after each event
}

func (s *sink) emit(m protocol.ServerMsg) {
	s.mu.Lock()
	s.msgs = append(s.msgs, m)
	s.mu.Unlock()
	if s.notify != nil {
		s.notify <- struct{}{}
	}
}

func (s *sink) snapshot() []protocol.ServerMsg {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]protocol.ServerMsg(nil), s.msgs...)
}

func strp(s string) *string { return &s }

var testOrigin = protocol.Origin{PublicIP: strp("203.0.113.9"), City: strp("Toronto")}

func newTestSource(t *testing.T, r *fakeRunner, e *fakeEnricher) *Source {
	t.Helper()
	s, err := New(Config{
		Runner:   r,
		Command:  func(target string) (string, []string) { return "traceroute", []string{"-n", target} },
		Enricher: e,
		Origin:   fakeOrigin{testOrigin},
	})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func hopEv(ttl int, ip string) trace.HopEvent {
	return trace.HopEvent{Hop: protocol.Hop{TTL: ttl, IP: strp(ip), Probes: []protocol.Probe{{IP: strp(ip)}}}}
}

func TestTraceStreamsStartedHopsUpdatesThenDone(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "one.one.one.one", ResolvedIP: "1.1.1.1"},
		hopEv(1, "10.0.0.1"),
		hopEv(2, "1.1.1.1"),
		trace.Done{Reached: true},
	}}
	e := &fakeEnricher{}
	var out sink
	if err := newTestSource(t, r, e).Trace(t.Context(), "one.one.one.one", out.emit); err != nil {
		t.Fatal(err)
	}
	msgs := out.snapshot()
	if len(msgs) != 6 {
		t.Fatalf("got %d events: %#v", len(msgs), msgs)
	}
	started, ok := msgs[0].(protocol.TraceStarted)
	if !ok || started.Target != "one.one.one.one" || started.ResolvedIP == nil || *started.ResolvedIP != "1.1.1.1" ||
		started.Origin.City == nil || *started.Origin.City != "Toronto" {
		t.Errorf("first event = %#v, want trace.started with origin", msgs[0])
	}
	if done, ok := msgs[5].(protocol.TraceDone); !ok || !done.Reached {
		t.Errorf("last event = %#v, want trace.done reached (after every update)", msgs[5])
	}
	updates := 0
	for _, m := range msgs[1:5] {
		if _, ok := m.(protocol.HopUpdate); ok {
			updates++
		}
	}
	if updates != 2 {
		t.Errorf("updates before done = %d, want 2", updates)
	}
	if got := r.calls[0]; len(got) != 3 || got[0] != "traceroute" || got[2] != "one.one.one.one" {
		t.Errorf("runner argv = %v", got)
	}
}

func TestTraceSetsGeoSourceOnEveryHop(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "1.1.1.1"},
		hopEv(1, "10.0.0.1"),
		trace.HopEvent{Hop: protocol.Hop{TTL: 2, Probes: []protocol.Probe{{}, {}, {}}}},
		trace.Done{},
	}}
	e := &fakeEnricher{}
	var out sink
	if err := newTestSource(t, r, e).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	for _, h := range e.hops {
		if !h.GeoSource.Valid() {
			t.Errorf("hop %d reached the enricher with geoSource %q", h.TTL, h.GeoSource)
		}
	}
}

func TestTraceErrorEventBecomesProtocolError(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.ErrorEvent{Code: protocol.ErrTracerouteMissing, Message: "traceroute not found"},
	}}
	var out sink
	if err := newTestSource(t, r, &fakeEnricher{}).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	msgs := out.snapshot()
	if len(msgs) != 1 {
		t.Fatalf("events = %#v", msgs)
	}
	if e, ok := msgs[0].(protocol.Error); !ok || e.Code != protocol.ErrTracerouteMissing {
		t.Errorf("event = %#v", msgs[0])
	}
}

func TestTraceRejectsInvalidTargetWithoutRunning(t *testing.T) {
	r := &fakeRunner{}
	var out sink
	if err := newTestSource(t, r, &fakeEnricher{}).Trace(t.Context(), "-rf /", out.emit); err != nil {
		t.Fatal(err)
	}
	msgs := out.snapshot()
	if e, ok := msgs[0].(protocol.Error); len(msgs) != 1 || !ok || e.Code != protocol.ErrInvalidTarget {
		t.Errorf("events = %#v", msgs)
	}
	if len(r.calls) != 0 {
		t.Error("runner must not start for an invalid target")
	}
}

func TestHopBeforeHeaderStillFollowsTraceStarted(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{hopEv(1, "10.0.0.1"), trace.Done{}}}
	var out sink
	if err := newTestSource(t, r, &fakeEnricher{}).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	msgs := out.snapshot()
	if s, ok := msgs[0].(protocol.TraceStarted); !ok || s.ResolvedIP != nil {
		t.Errorf("first event = %#v, want trace.started with null resolvedIp", msgs[0])
	}
	n := 0
	for _, m := range msgs {
		if _, ok := m.(protocol.TraceStarted); ok {
			n++
		}
	}
	if n != 1 {
		t.Errorf("trace.started sent %d times", n)
	}
}

func TestCancelWaitsForEnrichmentAndEmitsNothingAfterReturn(t *testing.T) {
	r := &fakeRunner{hold: true, events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "1.1.1.1"},
		hopEv(1, "10.0.0.1"),
	}}
	e := &fakeEnricher{gate: make(chan struct{})}
	out := sink{notify: make(chan struct{}, 16)}
	ctx, cancel := context.WithCancel(t.Context())
	returned := make(chan error, 1)
	go func() { returned <- newTestSource(t, r, e).Trace(ctx, "x", out.emit) }()

	deadline := time.After(testTimeout)
	for len(out.snapshot()) < 2 { // trace.started + hop
		select {
		case <-out.notify:
		case <-deadline:
			t.Fatalf("events = %#v", out.snapshot())
		}
	}
	cancel()
	select {
	case err := <-returned:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Trace: %v", err)
		}
	case <-deadline:
		t.Fatal("Trace did not return after cancel")
	}
	close(e.gate) // a late enrichment result after Trace returned
	n := len(out.snapshot())
	for _, m := range out.snapshot() {
		if _, ok := m.(protocol.TraceDone); ok {
			t.Error("trace.done must not follow a cancel")
		}
	}
	if n != 2 {
		t.Errorf("events = %#v, want only trace.started and the hop", out.snapshot())
	}
}
