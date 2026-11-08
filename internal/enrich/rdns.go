package enrich

import (
	"context"
	"net/netip"
	"strings"
	"time"
)

// AddrResolver does reverse DNS; *net.Resolver satisfies it.
type AddrResolver interface {
	LookupAddr(ctx context.Context, addr string) ([]string, error)
}

// RDNS performs reverse DNS lookups with a per-lookup timeout.
type RDNS struct {
	res     AddrResolver
	clock   Clock
	timeout time.Duration
}

// NewRDNS returns an RDNS lookup using res and clock.
func NewRDNS(res AddrResolver, clock Clock) *RDNS {
	return &RDNS{res: res, clock: clock, timeout: DefaultTimeout}
}

// Lookup returns the first PTR name for addr without its trailing dot.
func (r *RDNS) Lookup(ctx context.Context, addr netip.Addr) (string, bool) {
	ctx, cancel := withTimeout(ctx, r.clock, r.timeout)
	defer cancel()
	names, err := r.res.LookupAddr(ctx, addr.Unmap().String())
	if err != nil || len(names) == 0 {
		return "", false
	}
	name := strings.TrimSuffix(names[0], ".")
	return name, name != ""
}
