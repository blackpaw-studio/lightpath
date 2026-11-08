package enrich

import (
	"context"
	"net/netip"
	"sync"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// SelfLocator reports this machine's public IP and location (*IPAPI does).
type SelfLocator interface {
	Self(ctx context.Context) (netip.Addr, Geo, bool)
}

// ASNLookup resolves an address to its origin AS (*Cymru does).
type ASNLookup interface {
	Lookup(ctx context.Context, addr netip.Addr) (ASInfo, bool)
}

// OriginConfig wires an OriginResolver.
type OriginConfig struct {
	Self  SelfLocator
	ASN   ASNLookup
	Clock Clock
}

// OriginResolver finds where the trace starts: the user's public IP, its
// location and its ASN. It is fetched once (Start, at agent startup) and
// cached; a failed fetch is retried by the next Get.
type OriginResolver struct {
	cfg OriginConfig

	mu       sync.Mutex
	ctx      context.Context
	origin   protocol.Origin
	resolved bool          // Self succeeded; never fetched again
	running  chan struct{} // non-nil while a fetch is in flight; closed when it ends
}

// NewOriginResolver returns an unstarted resolver.
func NewOriginResolver(cfg OriginConfig) *OriginResolver {
	return &OriginResolver{cfg: cfg, ctx: context.Background()}
}

// Start begins the prefetch in the background. ctx bounds the fetch (and any
// retry a later Get triggers). Calling it again is harmless.
func (o *OriginResolver) Start(ctx context.Context) {
	o.mu.Lock()
	o.ctx = ctx
	o.startLocked()
	o.mu.Unlock()
}

// Peek returns what is known right now without waiting or fetching.
func (o *OriginResolver) Peek() protocol.Origin {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.origin
}

// Get returns the origin, waiting up to DefaultTimeout (or ctx) for a fetch
// in progress, and starting one first if none has succeeded yet. On timeout it
// returns whatever is known.
func (o *OriginResolver) Get(ctx context.Context) protocol.Origin {
	o.mu.Lock()
	o.startLocked()
	running := o.running
	o.mu.Unlock()

	if running != nil {
		wctx, cancel := withTimeout(ctx, o.cfg.Clock, DefaultTimeout)
		select {
		case <-running:
		case <-wctx.Done():
		}
		cancel()
	}
	return o.Peek()
}

func (o *OriginResolver) startLocked() {
	if o.resolved || o.running != nil {
		return
	}
	done := make(chan struct{})
	o.running = done
	ctx := o.ctx
	go func() {
		o.fetch(ctx)
		o.mu.Lock()
		o.running = nil
		o.mu.Unlock()
		close(done)
	}()
}

func (o *OriginResolver) fetch(ctx context.Context) {
	ip, geo, ok := o.cfg.Self.Self(ctx)
	if !ok {
		return
	}
	s, lat, lon, city := ip.String(), geo.Lat, geo.Lon, geo.City
	o.mu.Lock()
	o.origin.PublicIP, o.origin.Lat, o.origin.Lon = &s, &lat, &lon
	if city != "" {
		o.origin.City = &city
	}
	o.resolved = true
	o.mu.Unlock()

	info, ok := o.cfg.ASN.Lookup(ctx, ip)
	if !ok {
		return
	}
	asn, org := info.ASN, info.Org
	o.mu.Lock()
	o.origin.ASN = &asn
	if org != "" {
		o.origin.Org = &org
	}
	o.mu.Unlock()
}
