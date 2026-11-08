package enrich

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func okBatchHandler(hdr map[string]string) func(r recordedReq) (*http.Response, error) {
	return func(r recordedReq) (*http.Response, error) {
		var ips []string
		if err := json.Unmarshal([]byte(r.Body), &ips); err != nil {
			return httpResp(400, "bad", nil), nil
		}
		var sb strings.Builder
		sb.WriteString("[")
		for i, ip := range ips {
			if i > 0 {
				sb.WriteString(",")
			}
			fmt.Fprintf(&sb, `{"status":"success","query":%q,"lat":41.88,"lon":-87.63,"city":"Chicago","countryCode":"US"}`, ip)
		}
		sb.WriteString("]")
		return httpResp(200, sb.String(), hdr), nil
	}
}

func newTestIPAPI(t *testing.T, h *fakeHTTP, clk *fakeClock) *IPAPI {
	t.Helper()
	a := NewIPAPI(IPAPIConfig{HTTP: h, Clock: clk})
	t.Cleanup(a.Close)
	return a
}

func addrN(n int) netip.Addr {
	return netip.AddrFrom4([4]byte{8, 8, byte(n / 256), byte(n % 256)})
}

func TestIPAPILookupBatchesWithinWindow(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	c1 := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	c2 := a.enqueue(netip.MustParseAddr("1.1.1.1"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c1.done
	<-c2.done

	if h.count() != 1 {
		t.Fatalf("requests = %d, want 1", h.count())
	}
	req := h.reqs[0]
	if req.Method != "POST" || !strings.HasPrefix(req.URL, "http://ip-api.com/batch?") {
		t.Errorf("unexpected request %+v", req)
	}
	if !strings.Contains(req.URL, "fields=") {
		t.Errorf("fields param missing: %s", req.URL)
	}
	if !c1.ok || c1.geo.City != "Chicago" || c1.geo.Lat != 41.88 || c1.geo.Lon != -87.63 {
		t.Errorf("c1 = %+v ok=%v", c1.geo, c1.ok)
	}
}

func TestIPAPI150IPsMakeTwoRequests(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	calls := make([]*call, 150)
	for i := range calls {
		calls[i] = a.enqueue(addrN(i + 1))
	}
	// The first 100 flush as soon as the batch is full.
	first := h.next(t)
	var ips []string
	_ = json.Unmarshal([]byte(first.Body), &ips)
	if len(ips) != 100 {
		t.Fatalf("first batch = %d IPs, want 100", len(ips))
	}
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	second := h.next(t)
	_ = json.Unmarshal([]byte(second.Body), &ips)
	if len(ips) != 50 {
		t.Fatalf("second batch = %d IPs, want 50", len(ips))
	}
	for i, c := range calls {
		<-c.done
		if !c.ok {
			t.Fatalf("call %d has no result", i)
		}
	}
	if h.count() != 2 {
		t.Errorf("requests = %d, want 2", h.count())
	}
}

func TestIPAPIDuplicateIPsShareOneQuery(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c1 := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	c2 := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c1.done
	<-c2.done
	var ips []string
	_ = json.Unmarshal([]byte(h.reqs[0].Body), &ips)
	if len(ips) != 1 {
		t.Errorf("batch IPs = %v, want one", ips)
	}
}

func TestIPAPICacheHitMakesNoRequest(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done

	geo, ok := a.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8"))
	if !ok || geo.City != "Chicago" {
		t.Errorf("cache hit = %+v ok=%v", geo, ok)
	}
	if h.count() != 1 {
		t.Errorf("requests = %d, want 1", h.count())
	}
}

func TestIPAPINeverSendsLocalAddrs(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	a := newTestIPAPI(t, h, newFakeClock())
	for _, ip := range []string{"10.1.1.1", "192.168.0.1", "100.64.3.3", "fe80::1", "169.254.1.1"} {
		if _, ok := a.Lookup(t.Context(), netip.MustParseAddr(ip)); ok {
			t.Errorf("%s should not resolve", ip)
		}
	}
	if h.count() != 0 {
		t.Errorf("requests = %d, want 0", h.count())
	}
}

func TestIPAPIRateLimiterDelaysSixteenthRequest(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	// Full batches flush immediately, so no fake time passes between requests.
	roundOf := func(round int) []*call {
		calls := make([]*call, maxBatch)
		for i := range calls {
			calls[i] = a.enqueue(addrN(round*maxBatch + i + 1))
		}
		return calls
	}
	for round := 0; round < 15; round++ {
		for _, c := range roundOf(round) {
			<-c.done
		}
	}
	if h.count() != 15 {
		t.Fatalf("requests after burst = %d, want 15", h.count())
	}

	last := roundOf(15)
	// The 16th request must wait one token interval: 60s / 15 = 4s.
	clk.Await(t, 4*time.Second)
	if h.count() != 15 {
		t.Fatalf("16th request sent before the limiter allowed it (count %d)", h.count())
	}
	clk.Advance(4 * time.Second)
	for _, c := range last {
		<-c.done
	}
	if h.count() != 16 {
		t.Errorf("requests = %d, want 16", h.count())
	}
}

func TestIPAPIHonoursXRlZero(t *testing.T) {
	var n atomic.Int32
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		hdr := map[string]string{"X-Rl": "5", "X-Ttl": "60"}
		if n.Add(1) == 1 {
			hdr = map[string]string{"X-Rl": "0", "X-Ttl": "30"}
		}
		return okBatchHandler(hdr)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	c1 := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c1.done

	c2 := a.enqueue(netip.MustParseAddr("1.1.1.1"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	clk.Await(t, 30*time.Second-batchWindow)
	if h.count() != 1 {
		t.Fatalf("second request sent during X-Ttl block (count %d)", h.count())
	}
	clk.Advance(30 * time.Second)
	<-c2.done
	if h.count() != 2 {
		t.Errorf("requests = %d, want 2", h.count())
	}
}

func TestIPAPI429BlocksThenRetries(t *testing.T) {
	var n atomic.Int32
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		if n.Add(1) == 1 {
			return httpResp(429, "", map[string]string{"X-Rl": "0", "X-Ttl": "20"}), nil
		}
		return okBatchHandler(nil)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	h.next(t)
	clk.Await(t, 20*time.Second)
	clk.Advance(20 * time.Second)
	<-c.done
	if !c.ok || h.count() != 2 {
		t.Errorf("ok=%v requests=%d, want ok after one retry", c.ok, h.count())
	}
}

func TestIPAPICallerDeadlineReturnsEmptyWhileBatchPending(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan bool, 1)
	go func() {
		_, ok := a.Lookup(ctx, netip.MustParseAddr("8.8.8.8"))
		done <- ok
	}()
	clk.Await(t, batchWindow) // queued, batch not yet sent
	clk.Await(t, DefaultTimeout)
	cancel() // stands in for the caller's deadline
	if ok := <-done; ok {
		t.Fatal("lookup must return empty when the caller gives up")
	}
	if h.count() != 0 {
		t.Fatalf("batch sent early (count %d)", h.count())
	}
	// The batch still completes and warms the cache for later hops.
	clk.Advance(batchWindow)
	h.next(t)
	geo, ok := a.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8"))
	if !ok || geo.City != "Chicago" {
		t.Errorf("late result not cached: %+v ok=%v", geo, ok)
	}
}

func TestIPAPILookupTimesOutAfterTwoSeconds(t *testing.T) {
	gate := make(chan struct{})
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		<-gate
		return okBatchHandler(nil)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	t.Cleanup(func() { close(gate) })

	done := make(chan bool, 1)
	go func() {
		_, ok := a.Lookup(t.Context(), netip.MustParseAddr("8.8.8.8"))
		done <- ok
	}()
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	h.next(t) // request now stuck server-side
	clk.Advance(DefaultTimeout)
	if ok := <-done; ok {
		t.Error("lookup should give up after 2s while the request is outstanding")
	}
}

func TestIPAPIMalformedJSONYieldsEmptyAndIsNotCached(t *testing.T) {
	var n atomic.Int32
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		if n.Add(1) == 1 {
			return httpResp(200, "{not json", nil), nil
		}
		return okBatchHandler(nil)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done
	if c.ok {
		t.Fatal("malformed response must yield no result")
	}
	c = a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done
	if !c.ok {
		t.Error("failure should not have been cached")
	}
}

func TestIPAPIFailStatusIsNegativelyCached(t *testing.T) {
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		return httpResp(200, `[{"status":"fail","message":"reserved range","query":"8.8.8.8"}]`, nil), nil
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done
	if c.ok {
		t.Fatal("fail status must yield no result")
	}
	if c2 := a.enqueue(netip.MustParseAddr("8.8.8.8")); c2.ok || h.count() != 1 {
		t.Error("negative result should be served from cache without a request")
	}
}

func TestIPAPITransportErrorYieldsEmpty(t *testing.T) {
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) { return nil, errors.New("boom") })
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done
	if c.ok {
		t.Error("transport error must yield no result")
	}
}

func TestIPAPISelf(t *testing.T) {
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		return httpResp(200, `{"status":"success","query":"203.0.113.9","lat":40.7,"lon":-74,"city":"New York","countryCode":"US"}`, nil), nil
	})
	a := newTestIPAPI(t, h, newFakeClock())
	ip, geo, ok := a.Self(t.Context())
	if !ok || ip != netip.MustParseAddr("203.0.113.9") || geo.City != "New York" {
		t.Errorf("got %v %+v %v", ip, geo, ok)
	}
	if r := h.reqs[0]; r.Method != "GET" || !strings.HasPrefix(r.URL, "http://ip-api.com/json/?fields=") {
		t.Errorf("unexpected request %+v", r)
	}
}
