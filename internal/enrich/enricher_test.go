package enrich

import (
	"context"
	"net/netip"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// gated is a lookup that blocks until released, then returns val/ok.
type gated[T any] struct {
	release chan struct{}
	val     T
	ok      bool
	calls   atomic.Int32
}

func newGated[T any](val T, ok bool) *gated[T] {
	return &gated[T]{release: make(chan struct{}), val: val, ok: ok}
}

func (g *gated[T]) Lookup(ctx context.Context, _ netip.Addr) (T, bool) {
	g.calls.Add(1)
	select {
	case <-g.release:
		return g.val, g.ok
	case <-ctx.Done():
		var zero T
		return zero, false
	}
}

func (g *gated[T]) open() { close(g.release) }

type fakeOrigin struct {
	peek protocol.Origin
	get  protocol.Origin
}

func (f fakeOrigin) Peek() protocol.Origin               { return f.peek }
func (f fakeOrigin) Get(context.Context) protocol.Origin { return f.get }

type collector struct {
	mu   sync.Mutex
	msgs []protocol.ServerMsg
	sig  chan struct{}
}

func newCollector() *collector { return &collector{sig: make(chan struct{}, 64)} }

func (c *collector) emit(m protocol.ServerMsg) {
	c.mu.Lock()
	c.msgs = append(c.msgs, m)
	c.mu.Unlock()
	c.sig <- struct{}{}
}

func (c *collector) snapshot() []protocol.ServerMsg {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]protocol.ServerMsg(nil), c.msgs...)
}

// waitFor blocks until at least n messages were emitted.
func (c *collector) waitFor(t *testing.T, n int) []protocol.ServerMsg {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for len(c.snapshot()) < n {
		select {
		case <-c.sig:
		case <-deadline:
			t.Fatalf("got %d messages, want %d: %v", len(c.snapshot()), n, c.snapshot())
		}
	}
	return c.snapshot()
}

func ptr[T any](v T) *T { return &v }

type rig struct {
	host   *gated[string]
	asn    *gated[ASInfo]
	geo    *gated[Geo]
	origin fakeOrigin
	out    *collector
}

func newRig() *rig {
	return &rig{
		host: newGated("", false),
		asn:  newGated(ASInfo{}, false),
		geo:  newGated(Geo{}, false),
		out:  newCollector(),
	}
}

func (r *rig) enricher() *Enricher {
	return New(Config{Host: r.host, ASN: r.asn, Geo: r.geo, Origin: r.origin})
}

func hopAt(ttl int, ip string) protocol.Hop {
	return protocol.Hop{
		TTL: ttl, IP: ptr(ip), GeoSource: protocol.GeoEstimated,
		Probes: []protocol.Probe{{IP: ptr(ip), RTTMs: ptr(12.5)}},
	}
}

func TestHopIsEmittedBeforeEnrichmentResolves(t *testing.T) {
	r := newRig() // every lookup blocks
	wait := r.enricher().Enrich(t.Context(), hopAt(4, "8.8.8.8"), r.out.emit)

	msgs := r.out.snapshot()
	if len(msgs) != 1 {
		t.Fatalf("emitted %d messages synchronously, want exactly the hop", len(msgs))
	}
	hop, ok := msgs[0].(protocol.Hop)
	if !ok || hop.TTL != 4 || hop.GeoSource != protocol.GeoEstimated || hop.Host != nil || hop.ASN != nil {
		t.Fatalf("first message = %#v", msgs[0])
	}
	r.host.open()
	r.asn.open()
	r.geo.open()
	wait()
}

func TestLateASNUpdateCarriesOnlyASNAndOrg(t *testing.T) {
	r := newRig()
	r.asn.val, r.asn.ok = ASInfo{ASN: 64500, Org: "EXAMPLE-NET"}, true
	wait := r.enricher().Enrich(t.Context(), hopAt(4, "8.8.8.8"), r.out.emit)
	r.asn.open()
	msgs := r.out.waitFor(t, 2)
	want := protocol.NewHopUpdate(4, map[string]any{"asn": 64500, "org": "EXAMPLE-NET"})
	if !reflect.DeepEqual(msgs[1], protocol.ServerMsg(want)) {
		t.Errorf("update = %#v, want %#v", msgs[1], want)
	}
	r.host.open()
	r.geo.open()
	wait()
	if n := len(r.out.snapshot()); n != 2 {
		t.Errorf("%d messages, want hop + one update", n)
	}
}

func TestRDNSUpdateCarriesOnlyHost(t *testing.T) {
	r := newRig()
	r.host.val, r.host.ok = "dns.google", true
	wait := r.enricher().Enrich(t.Context(), hopAt(4, "8.8.8.8"), r.out.emit)
	r.host.open()
	msgs := r.out.waitFor(t, 2)
	want := protocol.NewHopUpdate(4, map[string]any{"host": "dns.google"})
	if !reflect.DeepEqual(msgs[1], protocol.ServerMsg(want)) {
		t.Errorf("update = %#v, want %#v", msgs[1], want)
	}
	r.asn.open()
	r.geo.open()
	wait()
}

var (
	amsterdam = Geo{Lat: 52.37, Lon: 4.90, City: "Amsterdam", CountryCode: "NL"}
	fraHost   = "be2.fra.as.example.net"
)

func TestHostnameHintOverridesAPIWhenAPIArrivesFirst(t *testing.T) {
	r := newRig()
	r.geo.val, r.geo.ok = amsterdam, true
	r.host.val, r.host.ok = fraHost, true
	wait := r.enricher().Enrich(t.Context(), hopAt(6, "198.51.100.7"), r.out.emit)

	r.geo.open()
	msgs := r.out.waitFor(t, 2)
	wantAPI := protocol.NewHopUpdate(6, map[string]any{
		"lat": 52.37, "lon": 4.90, "city": "Amsterdam", "geoSource": protocol.GeoAPI,
	})
	if !reflect.DeepEqual(msgs[1], protocol.ServerMsg(wantAPI)) {
		t.Fatalf("api update = %#v, want %#v", msgs[1], wantAPI)
	}

	r.host.open()
	msgs = r.out.waitFor(t, 3)
	fra := iataHints["fra"]
	wantHint := protocol.NewHopUpdate(6, map[string]any{
		"host": fraHost, "lat": fra.Lat, "lon": fra.Lon, "city": fra.City, "geoSource": protocol.GeoHostname,
	})
	if !reflect.DeepEqual(msgs[2], protocol.ServerMsg(wantHint)) {
		t.Errorf("hint update = %#v, want %#v", msgs[2], wantHint)
	}
	r.asn.open()
	wait()
}

func TestHostnameHintOverridesAPIWhenHostnameArrivesFirst(t *testing.T) {
	r := newRig()
	r.geo.val, r.geo.ok = amsterdam, true
	r.host.val, r.host.ok = fraHost, true
	wait := r.enricher().Enrich(t.Context(), hopAt(6, "198.51.100.7"), r.out.emit)

	r.host.open()
	msgs := r.out.waitFor(t, 2)
	fra := iataHints["fra"]
	wantHint := protocol.NewHopUpdate(6, map[string]any{
		"host": fraHost, "lat": fra.Lat, "lon": fra.Lon, "city": fra.City, "geoSource": protocol.GeoHostname,
	})
	if !reflect.DeepEqual(msgs[1], protocol.ServerMsg(wantHint)) {
		t.Fatalf("hint update = %#v, want %#v", msgs[1], wantHint)
	}

	r.geo.open() // late API result must not displace the hint
	r.asn.open()
	wait()
	if n := len(r.out.snapshot()); n != 2 {
		t.Errorf("late API geo produced an update: %v", r.out.snapshot()[2:])
	}
}

func TestAllLookupsFailingEmitsNoUpdates(t *testing.T) {
	r := newRig()
	r.host.open()
	r.asn.open()
	r.geo.open()
	wait := r.enricher().Enrich(t.Context(), hopAt(3, "203.0.113.1"), r.out.emit)
	wait()
	msgs := r.out.snapshot()
	if len(msgs) != 1 {
		t.Fatalf("messages = %v, want only the hop", msgs)
	}
	if h := msgs[0].(protocol.Hop); h.GeoSource != protocol.GeoEstimated || h.Lat != nil {
		t.Errorf("hop = %+v", h)
	}
}

func TestLocalHopTakesOriginLocationAndSkipsRemoteLookups(t *testing.T) {
	r := newRig()
	r.origin.peek = protocol.Origin{Lat: ptr(40.7), Lon: ptr(-74.0), City: ptr("New York")}
	r.host.val, r.host.ok = "gateway.fra.lan.example.net", true // must not trigger a hint
	r.host.open()
	wait := r.enricher().Enrich(t.Context(), hopAt(1, "192.168.1.1"), r.out.emit)
	wait()

	msgs := r.out.snapshot()
	hop := msgs[0].(protocol.Hop)
	if hop.GeoSource != protocol.GeoLocal || *hop.Lat != 40.7 || *hop.Lon != -74.0 || *hop.City != "New York" {
		t.Errorf("local hop = %+v", hop)
	}
	if r.asn.calls.Load() != 0 || r.geo.calls.Load() != 0 {
		t.Error("local hops must not query ASN or geo")
	}
	if len(msgs) != 2 {
		t.Fatalf("messages = %v", msgs)
	}
	want := protocol.NewHopUpdate(1, map[string]any{"host": "gateway.fra.lan.example.net"})
	if !reflect.DeepEqual(msgs[1], protocol.ServerMsg(want)) {
		t.Errorf("update = %#v, want only host", msgs[1])
	}
}

func TestLocalHopWaitsForOriginWhenNotYetKnown(t *testing.T) {
	r := newRig()
	r.origin.get = protocol.Origin{Lat: ptr(40.7), Lon: ptr(-74.0), City: ptr("New York")}
	r.host.open()
	wait := r.enricher().Enrich(t.Context(), hopAt(1, "10.0.0.1"), r.out.emit)
	wait()
	msgs := r.out.snapshot()
	if hop := msgs[0].(protocol.Hop); hop.GeoSource != protocol.GeoEstimated {
		t.Fatalf("hop before origin known = %+v", hop)
	}
	want := protocol.NewHopUpdate(1, map[string]any{
		"lat": 40.7, "lon": -74.0, "city": "New York", "geoSource": protocol.GeoLocal,
	})
	if len(msgs) != 2 || !reflect.DeepEqual(msgs[1], protocol.ServerMsg(want)) {
		t.Errorf("messages = %#v", msgs)
	}
}

func TestTimeoutHopIsPassedThroughUnenriched(t *testing.T) {
	r := newRig()
	hop := protocol.Hop{TTL: 7, Probes: []protocol.Probe{{}, {}, {}}, GeoSource: protocol.GeoEstimated}
	wait := r.enricher().Enrich(t.Context(), hop, r.out.emit)
	wait()
	msgs := r.out.snapshot()
	if len(msgs) != 1 {
		t.Fatalf("messages = %v", msgs)
	}
	if r.host.calls.Load()+r.asn.calls.Load()+r.geo.calls.Load() != 0 {
		t.Error("a hop with no IP must not be looked up")
	}
}

func TestCancelledContextStopsEnrichment(t *testing.T) {
	r := newRig() // lookups block until ctx ends
	ctx, cancel := context.WithCancel(t.Context())
	wait := r.enricher().Enrich(ctx, hopAt(2, "8.8.8.8"), r.out.emit)
	cancel()
	wait() // must return
	if n := len(r.out.snapshot()); n != 1 {
		t.Errorf("messages = %d, want only the hop", n)
	}
}
