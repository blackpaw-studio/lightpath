package live

import (
	"context"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"github.com/blackpaw-studio/lightpath/internal/reach"
	"github.com/blackpaw-studio/lightpath/internal/trace"
)

// fakeClock hands each registered timer to the test, which fires them. The
// channel is buffered and registrations beyond it are dropped, so tests that
// never look at timers are unaffected.
type fakeClock struct{ timers chan fakeTimer }

type fakeTimer struct {
	d    time.Duration
	fire chan time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{timers: make(chan fakeTimer, 16)} }

func (c *fakeClock) Now() time.Time { return time.Unix(1_700_000_000, 0) }

func (c *fakeClock) Timer(d time.Duration) (<-chan time.Time, func()) {
	t := fakeTimer{d: d, fire: make(chan time.Time, 1)}
	select {
	case c.timers <- t:
	default:
	}
	return t.fire, func() {}
}

// fakeReach answers Check with res; with block set it waits for ctx like a
// dial that hangs. exited is set once Check has returned.
type fakeReach struct {
	res   reach.Result
	block bool
	// partial: when blocking, return res (a connect that succeeded before the
	// cancel) instead of an empty result once ctx is done.
	partial bool

	mu     sync.Mutex
	calls  []netip.Addr
	exited atomic.Bool
	called chan struct{} // optional: closed on the first call
	once   sync.Once
}

func (f *fakeReach) Check(ctx context.Context, ip netip.Addr) reach.Result {
	defer f.exited.Store(true)
	f.mu.Lock()
	f.calls = append(f.calls, ip)
	f.mu.Unlock()
	if f.called != nil {
		f.once.Do(func() { close(f.called) })
	}
	if f.block {
		<-ctx.Done()
		if f.partial {
			return f.res
		}
		return reach.Result{}
	}
	return f.res
}

// destEnricher merges geo data into the destination hop (TTL 0) and leaves
// every other hop bare.
type destEnricher struct{}

func (destEnricher) Enrich(_ context.Context, hop protocol.Hop, emit func(protocol.ServerMsg)) func() {
	emit(hop)
	if hop.TTL == 0 {
		u, _ := protocol.NewHopUpdate(0, map[string]any{
			"host": "edge.example.net", "asn": 64502, "org": "EXAMPLE-CDN",
			"lat": 40.71, "lon": -74.0, "city": "New York", "geoSource": protocol.GeoAPI,
		})
		emit(u)
	}
	return func() {}
}

// hangingEnricher gives the destination a city, then never finishes its other
// lookups until the trace context is cancelled.
type hangingEnricher struct{}

func (hangingEnricher) Enrich(ctx context.Context, hop protocol.Hop, emit func(protocol.ServerMsg)) func() {
	emit(hop)
	if hop.TTL == 0 {
		u, _ := protocol.NewHopUpdate(0, map[string]any{"city": "Early", "geoSource": protocol.GeoAPI, "lat": 1.0, "lon": 2.0})
		emit(u)
		return func() { <-ctx.Done() }
	}
	return func() {}
}

func quietDone() trace.Done { return trace.Done{Reached: false, Reason: protocol.EndQuiet} }

func lastDone(t *testing.T, out *sink) protocol.TraceDone {
	t.Helper()
	msgs := out.snapshot()
	done, ok := msgs[len(msgs)-1].(protocol.TraceDone)
	if !ok {
		t.Fatalf("last event = %#v, want trace.done", msgs[len(msgs)-1])
	}
	return done
}

func TestQuietFinishCarriesTheEnrichedReachableDestination(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "198.51.100.77"},
		hopEv(1, "10.0.0.1"),
		quietDone(),
	}}
	rc := &fakeReach{res: reach.Result{Reachable: true, Port: 443, RTT: 18400 * time.Microsecond}}
	var out sink
	if err := newTestSourceReach(t, r, destEnricher{}, rc).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	done := lastDone(t, &out)
	if done.Reached || done.Reason == nil || *done.Reason != protocol.EndQuiet {
		t.Fatalf("done = %#v", done)
	}
	d := done.Destination
	if d == nil || d.IP != "198.51.100.77" || !d.Reachable || d.Port == nil || *d.Port != 443 ||
		d.RTTMs == nil || *d.RTTMs != 18.4 || d.ASN == nil || *d.ASN != 64502 ||
		d.City == nil || *d.City != "New York" || d.Lat == nil || d.GeoSource != protocol.GeoAPI {
		t.Fatalf("destination = %#v", d)
	}
	if len(rc.calls) != 1 || rc.calls[0] != netip.MustParseAddr("198.51.100.77") {
		t.Errorf("reach calls = %v", rc.calls)
	}
}

func TestUnreachableDestinationHasNoPortOrDelay(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "203.0.113.9"}, hopEv(1, "10.0.0.1"), quietDone(),
	}}
	var out sink
	if err := newTestSourceReach(t, r, destEnricher{}, &fakeReach{}).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	d := lastDone(t, &out).Destination
	if d == nil || d.Reachable || d.Port != nil || d.RTTMs != nil {
		t.Fatalf("destination = %#v", d)
	}
}

func TestDestinationsAreSentOnTheWireAndDecode(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "198.51.100.77"}, hopEv(1, "10.0.0.1"), quietDone(),
	}}
	rc := &fakeReach{res: reach.Result{Reachable: true, Port: 80, RTT: time.Millisecond}}
	var out sink
	if err := newTestSourceReach(t, r, destEnricher{}, rc).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	b, err := lastDone(t, &out).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.DecodeServer(b); err != nil {
		t.Fatalf("done does not round-trip: %s: %v", b, err)
	}
}

func TestNoHeaderMeansNoDestination(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{hopEv(1, "10.0.0.1"), quietDone()}}
	rc := &fakeReach{}
	var out sink
	if err := newTestSourceReach(t, r, destEnricher{}, rc).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	if d := lastDone(t, &out); d.Destination != nil {
		t.Errorf("destination = %#v, want absent", d.Destination)
	}
	if len(rc.calls) != 0 {
		t.Error("no header, so nothing to check")
	}
}

func TestReachedFinishKeepsLegacyReachedAndReason(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "1.1.1.1"}, hopEv(1, "1.1.1.1"),
		trace.Done{Reached: true, Reason: protocol.EndReached},
	}}
	var out sink
	if err := newTestSourceReach(t, r, destEnricher{}, &fakeReach{}).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	if d := lastDone(t, &out); !d.Reached || d.Reason == nil || *d.Reason != protocol.EndReached {
		t.Errorf("done = %#v", d)
	}
}

func TestCancelWaitsForTheDestinationCheck(t *testing.T) {
	r := &fakeRunner{hold: true, events: []trace.Event{trace.Header{Target: "x", ResolvedIP: "198.51.100.77"}}}
	rc := &fakeReach{block: true, called: make(chan struct{})}
	var out sink
	ctx, cancel := context.WithCancel(t.Context())
	returned := make(chan struct{})
	go func() {
		newTestSourceReach(t, r, destEnricher{}, rc).Trace(ctx, "x", out.emit)
		close(returned)
	}()
	select {
	case <-rc.called:
	case <-time.After(testTimeout):
		t.Fatal("check never started")
	}
	cancel()
	select {
	case <-returned:
	case <-time.After(testTimeout):
		t.Fatal("Trace did not return after cancel")
	}
	if !rc.exited.Load() {
		t.Error("Trace returned while the destination check was still running")
	}
	for _, m := range out.snapshot() {
		if _, ok := m.(protocol.TraceDone); ok {
			t.Error("trace.done must not follow a cancel")
		}
	}
}

func TestErrorPathJoinsTheCheckAndSendsNoDestination(t *testing.T) {
	r := &fakeRunner{events: []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "198.51.100.77"},
		trace.ErrorEvent{Code: protocol.ErrTracerouteFailed, Message: "boom"},
	}}
	rc := &fakeReach{res: reach.Result{Reachable: true, Port: 443, RTT: time.Millisecond}}
	var out sink
	if err := newTestSourceReach(t, r, destEnricher{}, rc).Trace(t.Context(), "x", out.emit); err != nil {
		t.Fatal(err)
	}
	msgs := out.snapshot()
	if e, ok := msgs[len(msgs)-1].(protocol.Error); !ok || e.Code != protocol.ErrTracerouteFailed {
		t.Fatalf("last event = %#v", msgs[len(msgs)-1])
	}
	if !rc.exited.Load() {
		t.Error("check not joined before Trace returned")
	}
}

func reachedEvents() []trace.Event {
	return []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "198.51.100.77"}, hopEv(1, "198.51.100.77"),
		trace.Done{Reached: true, Reason: protocol.EndReached},
	}
}

// traceAsync runs Trace and returns a channel carrying its completion.
func traceAsync(t *testing.T, s *Source, out *sink) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := s.Trace(t.Context(), "x", out.emit); err != nil {
			t.Error(err)
		}
	}()
	return done
}

func awaitTimer(t *testing.T, clk *fakeClock) fakeTimer {
	t.Helper()
	select {
	case tm := <-clk.timers:
		return tm
	case <-time.After(testTimeout):
		t.Fatal("no grace timer was started")
		return fakeTimer{}
	}
}

func awaitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("Trace did not return")
	}
}

func newClockedSource(t *testing.T, ev []trace.Event, enr Enricher, rc Reacher) (*Source, *fakeClock) {
	t.Helper()
	clk := newFakeClock()
	s, err := New(Config{
		Runner:   &fakeRunner{events: ev},
		Command:  func(target string) (string, []string) { return "traceroute", []string{target} },
		Enricher: enr, Origin: fakeOrigin{testOrigin}, Reach: rc, Clock: clk,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, clk
}

func TestDoneWaitsOnlyTheGraceForAHangingDestinationCheck(t *testing.T) {
	rc := &fakeReach{block: true}
	s, clk := newClockedSource(t, reachedEvents(), destEnricher{}, rc)
	var out sink
	done := traceAsync(t, s, &out)

	if tm := awaitTimer(t, clk); tm.d != DestGrace {
		t.Fatalf("grace = %v, want %v", tm.d, DestGrace)
	} else {
		select {
		case <-done:
			t.Fatal("Trace returned before the grace elapsed")
		default:
		}
		tm.fire <- time.Time{}
	}
	awaitDone(t, done)
	d := lastDone(t, &out)
	if !d.Reached || d.Destination == nil || d.Destination.Reachable || d.Destination.Port != nil {
		t.Fatalf("done = %#v, want reached with an unreachable destination", d)
	}
	if !rc.exited.Load() {
		t.Error("check not joined before Trace returned")
	}
}

func TestAnUnfinishedCheckKeepsASuccessfulPartialResult(t *testing.T) {
	rc := &fakeReach{block: true, partial: true, res: reach.Result{Reachable: true, Port: 443, RTT: 7 * time.Millisecond}}
	s, clk := newClockedSource(t, reachedEvents(), destEnricher{}, rc)
	var out sink
	done := traceAsync(t, s, &out)
	awaitTimer(t, clk).fire <- time.Time{}
	awaitDone(t, done)
	d := lastDone(t, &out).Destination
	if d == nil || !d.Reachable || d.Port == nil || *d.Port != 443 || d.RTTMs == nil || *d.RTTMs != 7 {
		t.Fatalf("destination = %#v, want the partial success kept", d)
	}
}

func TestSlowDestinationEnrichmentIsCutOffWithWhatItHas(t *testing.T) {
	s, clk := newClockedSource(t, reachedEvents(), hangingEnricher{}, &fakeReach{res: reach.Result{Reachable: true, Port: 80, RTT: time.Millisecond}})
	var out sink
	done := traceAsync(t, s, &out)
	awaitTimer(t, clk).fire <- time.Time{}
	awaitDone(t, done)
	d := lastDone(t, &out).Destination
	if d == nil || d.City == nil || *d.City != "Early" || d.GeoSource != protocol.GeoAPI || !d.Reachable {
		t.Fatalf("destination = %#v, want the fields gathered before the cut-off", d)
	}
}

func TestErrorDoesNotWaitForTheDestinationWork(t *testing.T) {
	ev := []trace.Event{
		trace.Header{Target: "x", ResolvedIP: "198.51.100.77"},
		trace.ErrorEvent{Code: protocol.ErrTracerouteFailed, Message: "boom"},
	}
	rc := &fakeReach{block: true}
	s, clk := newClockedSource(t, ev, hangingEnricher{}, rc)
	var out sink
	awaitDone(t, traceAsync(t, s, &out)) // nothing fires a timer: the error path must cancel on its own
	msgs := out.snapshot()
	if e, ok := msgs[len(msgs)-1].(protocol.Error); !ok || e.Code != protocol.ErrTracerouteFailed {
		t.Fatalf("last event = %#v", msgs[len(msgs)-1])
	}
	if !rc.exited.Load() || len(clk.timers) != 0 {
		t.Errorf("exited=%v timers=%d", rc.exited.Load(), len(clk.timers))
	}
}
