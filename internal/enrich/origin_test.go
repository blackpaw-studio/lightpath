package enrich

import (
	"context"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeSelf struct {
	calls atomic.Int32
	gate  chan struct{} // if non-nil, Self blocks until closed (or ctx ends)
	fail  atomic.Bool
}

func (f *fakeSelf) Self(ctx context.Context) (netip.Addr, Geo, bool) {
	f.calls.Add(1)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return netip.Addr{}, Geo{}, false
		}
	}
	if f.fail.Load() {
		return netip.Addr{}, Geo{}, false
	}
	return netip.MustParseAddr("203.0.113.9"), Geo{Lat: 40.7, Lon: -74, City: "New York"}, true
}

type fakeASN struct {
	mu   sync.Mutex
	info map[netip.Addr]ASInfo
}

func (f *fakeASN) Lookup(_ context.Context, a netip.Addr) (ASInfo, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i, ok := f.info[a]
	return i, ok
}

func newASN() *fakeASN {
	return &fakeASN{info: map[netip.Addr]ASInfo{
		netip.MustParseAddr("203.0.113.9"): {ASN: 64500, Org: "EXAMPLE-NET"},
	}}
}

func TestOriginGetReturnsFullOrigin(t *testing.T) {
	o := NewOriginResolver(OriginConfig{Self: &fakeSelf{}, ASN: newASN(), Clock: newFakeClock()})
	o.Start(t.Context())
	got := o.Get(t.Context())
	if got.PublicIP == nil || *got.PublicIP != "203.0.113.9" ||
		got.Lat == nil || *got.Lat != 40.7 || got.Lon == nil || *got.Lon != -74 ||
		got.City == nil || *got.City != "New York" ||
		got.ASN == nil || *got.ASN != 64500 || got.Org == nil || *got.Org != "EXAMPLE-NET" {
		t.Errorf("origin = %+v", got)
	}
}

func TestOriginFetchedOnceAndCached(t *testing.T) {
	self := &fakeSelf{}
	o := NewOriginResolver(OriginConfig{Self: self, ASN: newASN(), Clock: newFakeClock()})
	o.Start(t.Context())
	o.Get(t.Context())
	o.Get(t.Context())
	o.Start(t.Context())
	if n := self.calls.Load(); n != 1 {
		t.Errorf("Self called %d times, want 1", n)
	}
}

func TestOriginGetGivesUpAfterTwoSecondsWithPartialData(t *testing.T) {
	self := &fakeSelf{gate: make(chan struct{})}
	clk := newFakeClock()
	o := NewOriginResolver(OriginConfig{Self: self, ASN: newASN(), Clock: clk})
	o.Start(t.Context())

	done := make(chan struct{})
	var got = make(chan *struct{ ip *string }, 1)
	go func() {
		defer close(done)
		g := o.Get(t.Context())
		got <- &struct{ ip *string }{g.PublicIP}
	}()
	clk.Await(t, DefaultTimeout)
	clk.Advance(DefaultTimeout)
	select {
	case r := <-got:
		if r.ip != nil {
			t.Error("origin should be empty while the lookup is outstanding")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Get did not return after the 2s budget")
	}
	<-done

	close(self.gate) // lookup finishes late; a later Get sees it
	late := o.Get(t.Context())
	if late.PublicIP == nil {
		t.Error("late result should be visible to the next Get")
	}
}

func TestOriginRetriesAfterFailure(t *testing.T) {
	self := &fakeSelf{}
	self.fail.Store(true)
	o := NewOriginResolver(OriginConfig{Self: self, ASN: newASN(), Clock: newFakeClock()})
	o.Start(t.Context())
	if g := o.Get(t.Context()); g.PublicIP != nil {
		t.Fatalf("got %+v from a failing lookup", g)
	}
	self.fail.Store(false)
	if g := o.Get(t.Context()); g.PublicIP == nil {
		t.Error("a later Get should retry and succeed")
	}
	if n := self.calls.Load(); n != 2 {
		t.Errorf("Self called %d times, want 2", n)
	}
}

func TestOriginKeepsGeoWhenASNLookupFails(t *testing.T) {
	o := NewOriginResolver(OriginConfig{Self: &fakeSelf{}, ASN: &fakeASN{}, Clock: newFakeClock()})
	o.Start(t.Context())
	g := o.Get(t.Context())
	if g.PublicIP == nil || g.Lat == nil || g.ASN != nil || g.Org != nil {
		t.Errorf("origin = %+v", g)
	}
}

func TestOriginPeekNeverBlocks(t *testing.T) {
	o := NewOriginResolver(OriginConfig{Self: &fakeSelf{gate: make(chan struct{})}, ASN: newASN(), Clock: newFakeClock()})
	if g := o.Peek(); g.PublicIP != nil {
		t.Errorf("Peek before Start = %+v", g)
	}
}
