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

// fakeReach answers Check with res; with block set it waits for ctx like a
// dial that hangs. exited is set once Check has returned.
type fakeReach struct {
	res   reach.Result
	block bool

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
