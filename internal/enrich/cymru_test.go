package enrich

import (
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestCymruNames(t *testing.T) {
	if got := originName(netip.MustParseAddr("8.8.4.1")); got != "1.4.8.8.origin.asn.cymru.com" {
		t.Errorf("v4 name = %q", got)
	}
	got := originName(netip.MustParseAddr("2001:4860:4860::8888"))
	want := "8.8.8.8." + strings.Repeat("0.", 16) + "0.6.8.4.0.6.8.4.1.0.0.2.origin6.asn.cymru.com"
	if got != want {
		t.Errorf("v6 name = %q, want %q", got, want)
	}
}

func TestParseOrigin(t *testing.T) {
	cases := []struct {
		name string
		txt  []string
		want int
		ok   bool
	}{
		{"single", []string{"15169 | 8.8.8.0/24 | US | arin | 2023-12-28"}, 15169, true},
		{"quoted", []string{`"13335 | 1.1.1.0/24 | AU | apnic | 2011-08-11"`}, 13335, true},
		{"multi-record lowest", []string{"15169 | 8.8.8.0/24 | US | arin | x", "3356 | 8.8.8.0/24 | US | arin | x"}, 3356, true},
		{"multi-origin field", []string{"15169 701 | 8.8.8.0/24 | US | arin | x"}, 701, true},
		{"garbage", []string{"nonsense"}, 0, false},
		{"empty", nil, 0, false},
	}
	for _, c := range cases {
		got, ok := parseOrigin(c.txt)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: got (%d,%v), want (%d,%v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestParseASName(t *testing.T) {
	got, ok := parseASName([]string{"15169 | US | arin | 2000-03-30 | GOOGLE, US"})
	if !ok || got != "GOOGLE, US" {
		t.Errorf("got (%q,%v)", got, ok)
	}
	long, _ := parseASName([]string{"1 | US | arin | 2000-03-30 | " + strings.Repeat("X", 400)})
	if len(long) != maxFieldBytes {
		t.Errorf("org len = %d, want %d", len(long), maxFieldBytes)
	}
	if _, ok := parseASName([]string{"15169 | US | arin"}); ok {
		t.Error("short record should not parse")
	}
}

func cymruFixture() *fakeTXT {
	return &fakeTXT{records: map[string][]string{
		"8.8.8.8.origin.asn.cymru.com": {"15169 | 8.8.8.0/24 | US | arin | 2023-12-28"},
		"AS15169.asn.cymru.com":        {"15169 | US | arin | 2000-03-30 | GOOGLE, US"},
	}}
}

func TestCymruLookup(t *testing.T) {
	res := cymruFixture()
	c := NewCymru(res, newFakeClock())
	info, ok := c.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8"))
	if !ok || info.ASN != 15169 || info.Org != "GOOGLE, US" {
		t.Fatalf("got %+v ok=%v", info, ok)
	}
}

func TestCymruCachesByPrefixAndASN(t *testing.T) {
	res := cymruFixture()
	c := NewCymru(res, newFakeClock())
	for _, ip := range []string{"8.8.8.8", "8.8.8.9", "8.8.8.200"} {
		if _, ok := c.Lookup(t.Context(), netip.MustParseAddr(ip)); !ok {
			t.Fatalf("lookup %s failed", ip)
		}
	}
	// Different address, same /24: keyed by the first address's reversed name only
	// once (origin) plus one AS record.
	if n := res.callCount(); n != 2 {
		t.Errorf("resolver calls = %d, want 2 (1 origin + 1 AS)", n)
	}
}

func TestCymruNXDomainIsEmptyAndCached(t *testing.T) {
	res := &fakeTXT{}
	c := NewCymru(res, newFakeClock())
	for range 2 {
		if _, ok := c.Lookup(t.Context(), netip.MustParseAddr("203.0.113.5")); ok {
			t.Fatal("NXDOMAIN should yield no result")
		}
	}
	if n := res.callCount(); n != 1 {
		t.Errorf("resolver calls = %d, want 1 (negative cached)", n)
	}
}

func TestCymruSkipsLocalAddrs(t *testing.T) {
	res := cymruFixture()
	c := NewCymru(res, newFakeClock())
	if _, ok := c.Lookup(t.Context(), netip.MustParseAddr("10.0.0.1")); ok || res.callCount() != 0 {
		t.Error("local address must not be looked up")
	}
}

func TestCymruTimesOutAfterTwoSeconds(t *testing.T) {
	res := &fakeTXT{block: true}
	clk := newFakeClock()
	c := NewCymru(res, clk)
	done := make(chan bool, 1)
	go func() {
		_, ok := c.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8"))
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

func TestCymruTransientErrorNotCached(t *testing.T) {
	res := cymruFixture()
	res.err = map[string]error{"8.8.8.8.origin.asn.cymru.com": errTransient}
	c := NewCymru(res, newFakeClock())
	if _, ok := c.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8")); ok {
		t.Fatal("transient failure should yield no result")
	}
	delete(res.err, "8.8.8.8.origin.asn.cymru.com")
	if _, ok := c.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8")); !ok {
		t.Error("retry after transient failure should succeed")
	}
}

func TestCymruOrgFailureStillReturnsASN(t *testing.T) {
	res := &fakeTXT{records: map[string][]string{
		"8.8.8.8.origin.asn.cymru.com": {"15169 | 8.8.8.0/24 | US | arin | x"},
	}}
	c := NewCymru(res, newFakeClock())
	info, ok := c.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8"))
	if !ok || info.ASN != 15169 || info.Org != "" {
		t.Errorf("got %+v ok=%v", info, ok)
	}
}
