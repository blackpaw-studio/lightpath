// Package enrich adds reverse DNS, ASN, and geolocation data to traceroute
// hops. Everything that touches the network sits behind an injected interface
// (TXTResolver, AddrResolver, HTTPDoer, Clock) so it can be tested with fakes.
package enrich

import (
	"context"
	"net/http"
	"time"
	"unicode/utf8"
)

// DefaultTimeout bounds each individual enrichment lookup.
const DefaultTimeout = 2 * time.Second

// Clock abstracts time so tests never sleep.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
	// Timer is After with a stop function that releases the timer early.
	Timer(d time.Duration) (<-chan time.Time, func())
}

// HTTPDoer is the subset of *http.Client the package uses.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (realClock) Timer(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTimer(d)
	return t.C, func() { t.Stop() }
}

// RealClock is the wall clock.
var RealClock Clock = realClock{}

// withTimeout is context.WithTimeout driven by an injected Clock.
func withTimeout(ctx context.Context, clk Clock, d time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	timer, stop := clk.Timer(d)
	go func() {
		defer stop()
		select {
		case <-timer:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

// maxFieldBytes caps hostnames, cities and org names taken from the network.
const maxFieldBytes = 256

// capField truncates s to maxFieldBytes without splitting a UTF-8 sequence.
func capField(s string) string {
	if len(s) <= maxFieldBytes {
		return s
	}
	cut := maxFieldBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
