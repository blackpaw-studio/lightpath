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
	"unicode/utf8"
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

// A trace's hops arrive ~300 ms apart; the batch window must merge them so
// one 15-hop trace costs only a few of the 15 requests per minute.
func TestIPAPIFifteenHopTraceUsesAtMostThreeRequests(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	const hops, spacing = 15, 300 * time.Millisecond

	calls := make([]*call, hops)
	var windowEnd time.Duration // fake time since start; 0 = no window open
	now := time.Duration(0)
	advance := func(d time.Duration) {
		clk.Advance(d)
		now += d
		if windowEnd != 0 && now >= windowEnd {
			h.next(t) // the window closed: wait for its request
			windowEnd = 0
		}
	}
	for i := range calls {
		calls[i] = a.enqueue(addrN(i + 1))
		if windowEnd == 0 {
			clk.Await(t, batchWindow) // this hop opened a window
			windowEnd = now + batchWindow
		}
		advance(spacing)
	}
	for windowEnd != 0 {
		advance(spacing)
	}
	for i, c := range calls {
		<-c.done
		if !c.ok {
			t.Fatalf("hop %d has no geo", i+1)
		}
	}
	t.Logf("requests for a %d-hop trace: %d", hops, h.count())
	if h.count() > 3 {
		t.Errorf("requests = %d, want ≤ 3", h.count())
	}
	if batchWindow+250*time.Millisecond >= DefaultTimeout {
		t.Errorf("batch window %v leaves too little of the %v lookup timeout", batchWindow, DefaultTimeout)
	}
}

// A lookup that gives up during an X-Rl block must not lose the IP: it is
// fetched once the block clears, so the next trace's lookup is a cache hit.
func TestIPAPIFetchesAbandonedIPsAfterABlock(t *testing.T) {
	var n atomic.Int32
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		hdr := map[string]string{"X-Rl": "10", "X-Ttl": "60"}
		if n.Add(1) == 1 {
			hdr = map[string]string{"X-Rl": "0", "X-Ttl": "30"}
		}
		return okBatchHandler(hdr)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	first := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-first.done // quota exhausted for 30 s
	h.next(t)

	done := make(chan bool, 1)
	go func() {
		_, ok := a.Lookup(t.Context(), netip.MustParseAddr("1.1.1.1"))
		done <- ok
	}()
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	clk.Await(t, 30*time.Second-batchWindow) // sender waits out the block
	clk.Advance(DefaultTimeout)
	if <-done {
		t.Fatal("lookup should give up while the block lasts")
	}
	clk.Advance(30 * time.Second)
	if got := batchIPs(t, h.next(t)); len(got) != 1 || got[0] != "1.1.1.1" {
		t.Fatalf("batch after block = %v, want the abandoned IP", got)
	}
	geo, ok := a.Lookup(t.Context(), netip.MustParseAddr("1.1.1.1"))
	if !ok || geo.City != "Chicago" {
		t.Errorf("next lookup = %+v ok=%v, want the cached result", geo, ok)
	}
	if h.count() != 2 {
		t.Errorf("requests = %d, want 2 (second lookup served from cache)", h.count())
	}
}

// exhaustTokens spends n tokens with full (immediately flushed) batches and
// discards the recorded requests from h.seen.
func exhaustTokens(t *testing.T, a *IPAPI, h *fakeHTTP, n int) {
	t.Helper()
	for round := 0; round < n; round++ {
		calls := make([]*call, maxBatch)
		for i := range calls {
			calls[i] = a.enqueue(addrN(10000 + round*maxBatch + i))
		}
		for _, c := range calls {
			<-c.done
		}
	}
	for range n {
		h.next(t)
	}
}

func batchIPs(t *testing.T, r recordedReq) []string {
	t.Helper()
	var ips []string
	if err := json.Unmarshal([]byte(r.Body), &ips); err != nil {
		t.Fatalf("bad batch body %q: %v", r.Body, err)
	}
	return ips
}

func TestIPAPIMergesIPsQueuedWhileWaitingForAToken(t *testing.T) {
	h := newFakeHTTP(okBatchHandler(nil))
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	exhaustTokens(t, a, h, requestsPerIv)

	first := a.enqueue(netip.MustParseAddr("9.9.9.1"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	wait := clk.AwaitOther(t, batchWindow, DefaultTimeout)
	// Hops arriving while the sender waits for a token join its batch.
	second := a.enqueue(netip.MustParseAddr("9.9.9.2"))
	third := a.enqueue(netip.MustParseAddr("9.9.9.3"))
	clk.Advance(wait)
	req := h.next(t)
	for _, c := range []*call{first, second, third} {
		<-c.done
	}
	if got := batchIPs(t, req); len(got) != 3 {
		t.Errorf("batch = %v, want all three IPs in one request", got)
	}
	if h.count() != requestsPerIv+1 {
		t.Errorf("requests = %d, want %d", h.count(), requestsPerIv+1)
	}
}

// selfGate makes Self (GET) requests wait for release and answer with hdr;
// batch (POST) requests answer immediately with batchHdr.
type selfGate struct {
	release  chan map[string]string
	batchHdr map[string]string
}

func (g *selfGate) handle(r recordedReq) (*http.Response, error) {
	if r.Method == http.MethodGet {
		hdr := <-g.release
		return httpResp(200, `{"status":"success","query":"203.0.113.9","lat":1,"lon":2,"city":"X"}`, hdr), nil
	}
	return okBatchHandler(g.batchHdr)(r)
}

func TestIPAPIRechecksXRlBlockAfterWaitingForAToken(t *testing.T) {
	g := &selfGate{release: make(chan map[string]string)}
	h := newFakeHTTP(g.handle)
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	exhaustTokens(t, a, h, requestsPerIv-1)

	selfDone := make(chan struct{})
	go func() {
		a.Self(t.Context()) // spends the last token, then hangs server-side
		close(selfDone)
	}()
	h.next(t)
	pending := a.enqueue(netip.MustParseAddr("9.9.9.1"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	wait := clk.AwaitOther(t, batchWindow, DefaultTimeout, requestTimeout)
	// While the batch sleeps for a token, Self reports the quota is gone.
	g.release <- map[string]string{"X-Rl": "0", "X-Ttl": "30"}
	<-selfDone
	clk.Advance(wait)
	// The batch must now sit out the rest of the X-Ttl block, not send.
	clk.Await(t, 30*time.Second-wait) // block began at release, T0+250ms
	if h.count() != requestsPerIv {
		t.Fatalf("batch sent during an X-Rl:0 block (requests %d)", h.count())
	}
	clk.Advance(30 * time.Second)
	<-pending.done
	if h.count() != requestsPerIv+1 {
		t.Errorf("requests = %d, want %d", h.count(), requestsPerIv+1)
	}
}

func TestIPAPIBlocksWhenXRlDoesNotCoverInflightRequests(t *testing.T) {
	g := &selfGate{release: make(chan map[string]string, 1), batchHdr: map[string]string{"X-Rl": "1", "X-Ttl": "30"}}
	h := newFakeHTTP(g.handle)
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)

	go a.Self(t.Context()) // in flight for the whole test
	h.next(t)
	t.Cleanup(func() { g.release <- nil })

	first := a.enqueue(netip.MustParseAddr("9.9.9.1"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-first.done // X-Rl:1, but the outstanding Self request will use it

	second := a.enqueue(netip.MustParseAddr("9.9.9.2"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	clk.Await(t, 30*time.Second-batchWindow)
	if h.count() != 2 {
		t.Fatalf("request sent although X-Rl did not cover in-flight requests (count %d)", h.count())
	}
	clk.Advance(30 * time.Second)
	<-second.done
}

func TestIPAPICountsDownXRlBetweenResponses(t *testing.T) {
	var n atomic.Int32
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		hdr := map[string]string{"X-Rl": "9", "X-Ttl": "60"}
		if n.Add(1) == 1 {
			hdr = map[string]string{"X-Rl": "1", "X-Ttl": "30"}
		}
		return okBatchHandler(hdr)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	gen := 0
	round := func() {
		gen++
		c := a.enqueue(addrN(gen))
		clk.Await(t, batchWindow)
		clk.Advance(batchWindow)
		<-c.done
	}
	round() // X-Rl:1 → one request left in this window
	round() // uses it
	third := a.enqueue(addrN(99))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	clk.Await(t, 30*time.Second-2*batchWindow)
	if h.count() != 2 {
		t.Fatalf("third request sent after X-Rl was used up (count %d)", h.count())
	}
	clk.Advance(30 * time.Second)
	<-third.done
}

func TestIPAPIBatchRequestTimesOut(t *testing.T) {
	var n atomic.Int32
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		if n.Add(1) == 1 {
			<-r.Ctx.Done() // hung connection
			return nil, r.Ctx.Err()
		}
		return okBatchHandler(nil)(r)
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	h.next(t)
	clk.Await(t, requestTimeout)
	clk.Advance(requestTimeout)
	<-c.done
	if c.ok {
		t.Fatal("a timed-out request must yield no result")
	}
	// The sender is free again.
	c = a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done
	if !c.ok {
		t.Error("request after a timeout should succeed")
	}
}

func TestIPAPISelfRequestTimesOut(t *testing.T) {
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		<-r.Ctx.Done()
		return nil, r.Ctx.Err()
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	done := make(chan bool, 1)
	go func() {
		_, _, ok := a.Self(context.Background())
		done <- ok
	}()
	h.next(t)
	clk.Await(t, requestTimeout)
	clk.Advance(requestTimeout)
	if <-done {
		t.Error("Self must fail when its request hangs")
	}
}

func TestIPAPICapsCityLength(t *testing.T) {
	long := strings.Repeat("é", 200) // 400 bytes
	h := newFakeHTTP(func(r recordedReq) (*http.Response, error) {
		return httpResp(200, `[{"status":"success","query":"8.8.8.8","lat":1,"lon":2,"city":"`+long+`"}]`, nil), nil
	})
	clk := newFakeClock()
	a := newTestIPAPI(t, h, clk)
	c := a.enqueue(netip.MustParseAddr("8.8.8.8"))
	clk.Await(t, batchWindow)
	clk.Advance(batchWindow)
	<-c.done
	if len(c.geo.City) > maxFieldBytes || !utf8.ValidString(c.geo.City) || c.geo.City == "" {
		t.Errorf("city len %d valid=%v", len(c.geo.City), utf8.ValidString(c.geo.City))
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
