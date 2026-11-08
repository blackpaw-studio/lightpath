package enrich

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"
)

type fakeAddr struct {
	names map[string][]string
	block bool
}

func (f fakeAddr) LookupAddr(ctx context.Context, addr string) ([]string, error) {
	if f.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if n, ok := f.names[addr]; ok {
		return n, nil
	}
	return nil, errors.New("no such host")
}

func TestRDNSTrimsDotAndTakesFirst(t *testing.T) {
	r := NewRDNS(fakeAddr{names: map[string][]string{"1.1.1.1": {"one.one.one.one.", "other.example."}}}, newFakeClock())
	got, ok := r.Lookup(t.Context(), netip.MustParseAddr("1.1.1.1"))
	if !ok || got != "one.one.one.one" {
		t.Errorf("got (%q,%v)", got, ok)
	}
}

func TestRDNSFailureYieldsNothing(t *testing.T) {
	r := NewRDNS(fakeAddr{}, newFakeClock())
	if _, ok := r.Lookup(t.Context(), netip.MustParseAddr("203.0.113.1")); ok {
		t.Error("failed lookup must report no result")
	}
}

func TestRDNSTimesOut(t *testing.T) {
	clk := newFakeClock()
	r := NewRDNS(fakeAddr{block: true}, clk)
	done := make(chan bool, 1)
	go func() {
		_, ok := r.Lookup(t.Context(), netip.MustParseAddr("1.1.1.1"))
		done <- ok
	}()
	clk.Await(t, DefaultTimeout)
	clk.Advance(DefaultTimeout)
	select {
	case ok := <-done:
		if ok {
			t.Error("timed-out lookup must report no result")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("lookup did not return after the timeout")
	}
}

func TestRDNSCapsNameLength(t *testing.T) {
	long := strings.Repeat("a", 300) + ".example."
	r := NewRDNS(fakeAddr{names: map[string][]string{"1.1.1.1": {long}}}, newFakeClock())
	got, ok := r.Lookup(t.Context(), netip.MustParseAddr("1.1.1.1"))
	if !ok || len(got) != maxFieldBytes {
		t.Errorf("len = %d ok=%v, want %d", len(got), ok, maxFieldBytes)
	}
}
