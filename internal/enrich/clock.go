// Package enrich adds reverse DNS, ASN, and geolocation data to traceroute
// hops. Everything that touches the network sits behind an injected interface
// (TXTResolver, AddrResolver, HTTPDoer, Clock) so it can be tested with fakes.
package enrich

import (
	"context"
	"net/http"
	"time"
)

// DefaultTimeout bounds each individual enrichment lookup.
const DefaultTimeout = 2 * time.Second

// Clock abstracts time so tests never sleep.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

// HTTPDoer is the subset of *http.Client the package uses.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// RealClock is the wall clock.
var RealClock Clock = realClock{}

// withTimeout is context.WithTimeout driven by an injected Clock.
func withTimeout(ctx context.Context, clk Clock, d time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	timer := clk.After(d)
	go func() {
		select {
		case <-timer:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}
