package enrich

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"sync"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// HostLookup resolves an address to a hostname (*RDNS does).
type HostLookup interface {
	Lookup(ctx context.Context, addr netip.Addr) (string, bool)
}

// GeoLookup geolocates a public address (*IPAPI does).
type GeoLookup interface {
	Lookup(ctx context.Context, addr netip.Addr) (Geo, bool)
}

// OriginSource supplies the trace origin (*OriginResolver does). Peek must not
// block; Get may wait for an outstanding fetch.
type OriginSource interface {
	Peek() protocol.Origin
	Get(ctx context.Context) protocol.Origin
}

// Config wires an Enricher. Hint defaults to HintFor.
type Config struct {
	Host   HostLookup
	ASN    ASNLookup
	Geo    GeoLookup
	Origin OriginSource
	Hint   func(host string) (Hint, bool)
}

// Enricher fills in hostname, ASN and location for hops as they arrive.
type Enricher struct {
	cfg Config
}

// New returns an Enricher.
func New(cfg Config) *Enricher {
	if cfg.Hint == nil {
		cfg.Hint = HintFor
	}
	return &Enricher{cfg: cfg}
}

// Enrich emits hop on emit synchronously (with geoSource "estimated" unless a
// local location is already known), then resolves rDNS, ASN and geo
// concurrently and emits a hop.update containing only the fields each result
// changed. It returns immediately; wait blocks until every lookup finished.
//
// emit is called from the caller's goroutine for the hop and from lookup
// goroutines for updates, always serialised per hop. It must not block
// indefinitely or call back into Enrich. Cancelling ctx abandons outstanding
// lookups without further updates.
//
// Precedence for location: local (origin) > hostname hint > API. Hostname
// hints never apply to local hops and win over API geo in either arrival order.
func (e *Enricher) Enrich(ctx context.Context, hop protocol.Hop, emit func(protocol.ServerMsg)) (wait func()) {
	s := &hopState{hop: hop, emit: emit, hint: e.cfg.Hint}
	s.hop.GeoSource = protocol.GeoEstimated

	addr, err := netip.ParseAddr(deref(hop.IP))
	if hop.IP == nil || err != nil {
		emit(s.hop)
		return func() {}
	}
	addr = addr.Unmap()
	s.local = IsLocal(addr)
	originKnown := false
	if s.local {
		originKnown = s.adoptOrigin(e.cfg.Origin.Peek(), change{})
	}
	emit(s.hop)

	var wg sync.WaitGroup
	run := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f()
		}()
	}
	run(func() {
		if host, ok := e.cfg.Host.Lookup(ctx, addr); ok && ctx.Err() == nil {
			s.applyHost(host)
		}
	})
	switch {
	case !s.local:
		run(func() {
			if info, ok := e.cfg.ASN.Lookup(ctx, addr); ok && ctx.Err() == nil {
				s.applyASN(info)
			}
		})
		run(func() {
			if geo, ok := e.cfg.Geo.Lookup(ctx, addr); ok && ctx.Err() == nil {
				s.applyGeo(geo)
			}
		})
	case !originKnown:
		run(func() {
			if o := e.cfg.Origin.Get(ctx); ctx.Err() == nil {
				s.applyOrigin(o)
			}
		})
	}
	return wg.Wait
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// hopState is the evolving view of one hop; every mutation yields at most one
// update holding just the fields that changed.
type hopState struct {
	mu        sync.Mutex
	hop       protocol.Hop
	local     bool
	geoLocked bool // local or hostname location applied: API geo must not override
	emit      func(protocol.ServerMsg)
	hint      func(string) (Hint, bool)
}

// change records one field update; set only records real changes.
type change map[string]any

func setPtr[T comparable](dst **T, v T, key string, ch change) {
	if *dst != nil && **dst == v {
		return
	}
	*dst = &v
	ch[key] = v
}

func (s *hopState) setLocation(lat, lon float64, city string, src protocol.GeoSource, ch change) {
	setPtr(&s.hop.Lat, lat, "lat", ch)
	setPtr(&s.hop.Lon, lon, "lon", ch)
	if city != "" {
		setPtr(&s.hop.City, city, "city", ch)
	}
	if s.hop.GeoSource != src {
		s.hop.GeoSource = src
		ch["geoSource"] = src
	}
}

// adoptOrigin gives a local hop the origin's location, recording the diff in
// ch; false if the origin has no coordinates yet.
func (s *hopState) adoptOrigin(o protocol.Origin, ch change) bool {
	if o.Lat == nil || o.Lon == nil {
		return false
	}
	city := ""
	if o.City != nil {
		city = *o.City
	}
	s.setLocation(*o.Lat, *o.Lon, city, protocol.GeoLocal, ch)
	s.geoLocked = true
	return true
}

// mutate runs f under the hop lock and emits the resulting diff, if any.
func (s *hopState) mutate(f func(ch change)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := change{}
	f(ch)
	if len(ch) > 0 {
		s.emit(protocol.NewHopUpdate(s.hop.TTL, ch))
	}
}

func (s *hopState) applyHost(host string) {
	s.mutate(func(ch change) {
		setPtr(&s.hop.Host, host, "host", ch)
		if s.local {
			return
		}
		if h, ok := s.hint(host); ok {
			s.setLocation(h.Lat, h.Lon, h.City, protocol.GeoHostname, ch)
			s.geoLocked = true
		}
	})
}

func (s *hopState) applyASN(info ASInfo) {
	s.mutate(func(ch change) {
		setPtr(&s.hop.ASN, info.ASN, "asn", ch)
		if info.Org != "" {
			setPtr(&s.hop.Org, info.Org, "org", ch)
		}
	})
}

func (s *hopState) applyGeo(g Geo) {
	s.mutate(func(ch change) {
		if s.geoLocked {
			return
		}
		s.setLocation(g.Lat, g.Lon, g.City, protocol.GeoAPI, ch)
	})
}

func (s *hopState) applyOrigin(o protocol.Origin) {
	s.mutate(func(ch change) { s.adoptOrigin(o, ch) })
}

// Compile-time checks that the production types satisfy the injected interfaces.
var (
	_ HostLookup   = (*RDNS)(nil)
	_ ASNLookup    = (*Cymru)(nil)
	_ GeoLookup    = (*IPAPI)(nil)
	_ SelfLocator  = (*IPAPI)(nil)
	_ OriginSource = (*OriginResolver)(nil)
	_ TXTResolver  = (*net.Resolver)(nil)
	_ AddrResolver = (*net.Resolver)(nil)
	_ HTTPDoer     = (*http.Client)(nil)
)
