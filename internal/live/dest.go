package live

import (
	"context"
	"net/netip"
	"sync"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"github.com/blackpaw-studio/lightpath/internal/reach"
)

// DestGrace is how long trace.done waits, after the runner finishes, for the
// destination's TCP check and enrichment. They start at the header and almost
// always finish long before; a host that answers traces but drops TCP must not
// hold the result back by a dial timeout.
const DestGrace = 500 * time.Millisecond

// destRun is the destination's side work for one trace: a TCP reachability
// check and the same enrichment hops get. Neither emits on the wire; the
// result travels inside trace.done.
type destRun struct {
	ip         netip.Addr
	cancel     context.CancelFunc // ends the check and the enrichment
	checkDone  sync.WaitGroup
	result     reach.Result
	enrichWait func()

	mu  sync.Mutex // guards hop; enrichment updates arrive from other goroutines
	hop protocol.Hop
}

// startDest begins the check and enrichment for the resolved destination. An
// unparseable address means there is nothing to check.
func (r *traceRun) startDest(resolvedIP string) {
	ip, err := netip.ParseAddr(resolvedIP)
	if err != nil || r.dest != nil {
		return
	}
	ip = ip.Unmap()
	text := ip.String()
	ctx, cancel := context.WithCancel(r.ctx)
	d := &destRun{ip: ip, cancel: cancel, hop: protocol.Hop{TTL: 0, IP: &text, GeoSource: protocol.GeoEstimated}}
	r.dest = d
	d.checkDone.Go(func() { d.result = r.src.cfg.Reach.Check(ctx, ip) })
	d.enrichWait = r.src.cfg.Enricher.Enrich(ctx, d.hop, d.collect)
}

// collect folds the destination's hop and its hop.updates into d.hop.
func (d *destRun) collect(m protocol.ServerMsg) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch m := m.(type) {
	case protocol.Hop:
		d.hop = m
	case protocol.HopUpdate:
		applyUpdate(&d.hop, m)
	}
}

// applyUpdate copies the fields a hop.update carries onto hop; null clears.
func applyUpdate(hop *protocol.Hop, u protocol.HopUpdate) {
	for k, v := range u {
		switch k {
		case "host":
			hop.Host = ptrOf[string](v)
		case "org":
			hop.Org = ptrOf[string](v)
		case "city":
			hop.City = ptrOf[string](v)
		case "asn":
			hop.ASN = ptrOf[int](v)
		case "lat":
			hop.Lat = ptrOf[float64](v)
		case "lon":
			hop.Lon = ptrOf[float64](v)
		case "ip":
			hop.IP = ptrOf[string](v)
		case "geoSource":
			if g, ok := v.(protocol.GeoSource); ok && g.Valid() {
				hop.GeoSource = g
			}
		}
	}
}

// ptrOf returns a pointer to v when it holds a T, otherwise nil.
func ptrOf[T any](v any) *T {
	t, ok := v.(T)
	if !ok {
		return nil
	}
	return &t
}

// destWait joins the check and the enrichment and returns the destination for
// trace.done, or nil if there was none. It is safe to call more than once.
//
// With grace, unfinished work gets DestGrace to complete and is then cancelled;
// without it the work is cancelled at once. A cancelled check reports whatever
// it had: reach.Checker keeps a connect that already succeeded (port and best
// delay) and otherwise reports unreachable. A cancelled enrichment leaves the
// fields it had gathered; the rest stay null. Either way the work is joined
// before destWait returns, so nothing runs on after Trace does.
func (r *traceRun) destWait(grace bool) *protocol.Destination {
	d := r.dest
	if d == nil {
		return nil
	}
	r.dest = nil
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		d.checkDone.Wait()
		d.enrichWait()
	}()
	if grace {
		r.awaitGrace(joined)
	}
	d.cancel()
	<-joined
	d.mu.Lock()
	defer d.mu.Unlock()
	out := &protocol.Destination{
		IP: d.ip.String(), Reachable: d.result.Reachable,
		Host: d.hop.Host, ASN: d.hop.ASN, Org: d.hop.Org,
		Lat: d.hop.Lat, Lon: d.hop.Lon, City: d.hop.City, GeoSource: d.hop.GeoSource,
	}
	if d.result.Reachable {
		port := d.result.Port
		ms := float64(d.result.RTT) / float64(time.Millisecond)
		out.Port, out.RTTMs = &port, &ms
	}
	return out
}

// awaitGrace returns when joined closes, DestGrace elapses or the trace is cancelled.
func (r *traceRun) awaitGrace(joined <-chan struct{}) {
	select {
	case <-joined:
		return
	default:
	}
	expired, stop := r.src.cfg.Clock.Timer(DestGrace)
	defer stop()
	select {
	case <-joined:
	case <-expired:
	case <-r.ctx.Done():
	}
}
