package enrich

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	ipAPIFields = "status,message,query,lat,lon,city,countryCode"
	batchURL    = "http://ip-api.com/batch?fields=" + ipAPIFields
	selfURL     = "http://ip-api.com/json/?fields=" + ipAPIFields
	// batchWindow merges hops that arrive ~300 ms apart: a 15-hop trace
	// fits in three windows (≤3 requests), and the first hop of a window
	// still gets its result well inside the 2 s lookup timeout.
	batchWindow    = 1250 * time.Millisecond
	maxBatch       = 100
	requestsPerIv  = 15 // ip-api free tier: 15 requests per minute per IP
	rateInterval   = time.Minute
	defaultBlock   = time.Minute // wait when a 429 carries no X-Ttl
	maxRespBytes   = 1 << 20
	requestTimeout = 10 * time.Second // bounds each HTTP attempt
)

// Geo is a geolocation result.
type Geo struct {
	Lat, Lon    float64
	City        string
	CountryCode string
}

// IPAPIConfig configures NewIPAPI. HTTP and Clock are required; the rest
// default to the ip-api.com free-tier values (tests override them).
type IPAPIConfig struct {
	HTTP     HTTPDoer
	Clock    Clock
	BatchURL string
	SelfURL  string
}

type call struct {
	done chan struct{}
	geo  Geo
	ok   bool
}

// maxPending bounds how many distinct IPs may be queued or in a request.
const maxPending = 1024

// IPAPI geolocates public IPs through ip-api.com. One sender goroutine owns
// all batch traffic: it waits out a 1.25 s window (or until 100 IPs queue),
// takes a token from a 15 req/min bucket, honours X-Rl/X-Ttl/429 blocks, and
// only then takes up to 100 queued IPs, so everything that queued while it
// waited rides in the same request. A caller that gives up (2 s) does not
// remove its IP: it is still fetched later and warms the cache for the next
// trace. At most one batch request is in flight and at most maxPending IPs are
// queued or in flight; Self requests share the same limiter. Results (including "fail" results) are cached for the
// lifetime of the value, which is longer than one run on purpose: it conserves
// the shared rate-limit budget.
type IPAPI struct {
	cfg     IPAPIConfig
	limiter *rate.Limiter
	ctx     context.Context
	cancel  context.CancelFunc
	wake    chan struct{} // buffered(1): queue changed
	stopped chan struct{} // closed when the sender exits

	mu           sync.Mutex
	cache        map[netip.Addr]*call // completed
	pending      map[netip.Addr]*call // queued or in a request
	queue        []netip.Addr         // FIFO of unsent IPs, each pending exactly once
	blockedUntil time.Time            // no request may start before this
	inflightReqs int                  // requests sent and not yet answered
	rlLeft       int                  // requests left per the last X-Rl, minus sends since
	rlReset      time.Time            // when rlLeft stops applying
}

// NewIPAPI returns a client and starts its sender. Call Close to stop it.
func NewIPAPI(cfg IPAPIConfig) *IPAPI {
	if cfg.BatchURL == "" {
		cfg.BatchURL = batchURL
	}
	if cfg.SelfURL == "" {
		cfg.SelfURL = selfURL
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &IPAPI{
		cfg:     cfg,
		limiter: rate.NewLimiter(rate.Every(rateInterval/requestsPerIv), requestsPerIv),
		ctx:     ctx,
		cancel:  cancel,
		wake:    make(chan struct{}, 1),
		stopped: make(chan struct{}),
		cache:   map[netip.Addr]*call{},
		pending: map[netip.Addr]*call{},
	}
	go a.run()
	return a
}

// Close cancels in-flight and queued work (pending lookups return empty) and
// waits for the sender to exit.
func (a *IPAPI) Close() {
	a.cancel()
	<-a.stopped
}

// Lookup geolocates a public address, waiting at most DefaultTimeout (or until
// ctx ends). Local addresses are never sent. ok=false means "unknown".
func (a *IPAPI) Lookup(ctx context.Context, addr netip.Addr) (Geo, bool) {
	addr = addr.Unmap()
	if !addr.IsValid() || IsLocal(addr) || !addr.IsGlobalUnicast() {
		return Geo{}, false
	}
	ctx, cancel := withTimeout(ctx, a.cfg.Clock, DefaultTimeout)
	defer cancel()
	c := a.enqueue(addr)
	select {
	case <-c.done:
		return c.geo, c.ok
	case <-ctx.Done():
		return Geo{}, false // the IP stays queued and will warm the cache
	}
}

var closedCall = func() *call {
	c := &call{done: make(chan struct{})}
	close(c.done)
	return c
}()

// enqueue returns the call for addr: cached, already pending, or newly queued.
func (a *IPAPI) enqueue(addr netip.Addr) *call {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.cache[addr]; ok {
		return c
	}
	if c, ok := a.pending[addr]; ok {
		return c
	}
	if a.ctx.Err() != nil || len(a.pending) >= maxPending {
		return closedCall
	}
	c := &call{done: make(chan struct{})}
	a.pending[addr] = c
	a.queue = append(a.queue, addr)
	a.signal()
	return c
}

func (a *IPAPI) signal() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *IPAPI) queuedCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.queue)
}

// run is the single sender loop.
func (a *IPAPI) run() {
	defer close(a.stopped)
	defer a.failPending()
	for {
		if a.queuedCount() == 0 {
			select {
			case <-a.wake:
				continue
			case <-a.ctx.Done():
				return
			}
		}
		if !a.awaitWindow() {
			return
		}
		a.sendNext()
		if a.ctx.Err() != nil {
			return
		}
	}
}

// awaitWindow waits batchWindow, or less once a full batch has queued. It
// reports false when the client is closed.
func (a *IPAPI) awaitWindow() bool {
	if a.queuedCount() >= maxBatch {
		return true
	}
	timer, stop := a.cfg.Clock.Timer(batchWindow)
	defer stop()
	for {
		select {
		case <-timer:
			return true
		case <-a.wake:
			if a.queuedCount() >= maxBatch {
				return true
			}
		case <-a.ctx.Done():
			return false
		}
	}
}

// takeBatch removes and returns up to maxBatch queued IPs.
func (a *IPAPI) takeBatch() []netip.Addr {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := min(len(a.queue), maxBatch)
	batch := append([]netip.Addr(nil), a.queue[:n]...)
	a.queue = append([]netip.Addr(nil), a.queue[n:]...)
	return batch
}

var errNothingToSend = errors.New("ipapi: nothing to send")

// sendNext waits for a turn, then takes and sends one batch. The batch is
// taken only once the request may start, so it includes every IP that queued
// while the sender waited.
func (a *IPAPI) sendNext() {
	var batch []netip.Addr
	data, err := a.do(a.ctx, func(ctx context.Context) (*http.Request, error) {
		if batch == nil {
			batch = a.takeBatch()
		}
		if len(batch) == 0 {
			return nil, errNothingToSend
		}
		return newBatchRequest(ctx, a.cfg.BatchURL, batch)
	})
	if len(batch) == 0 {
		return
	}
	results, cacheable := parseBatch(data, err)
	a.resolve(batch, results, cacheable)
}

func newBatchRequest(ctx context.Context, url string, batch []netip.Addr) (*http.Request, error) {
	ips := make([]string, len(batch))
	for i, addr := range batch {
		ips[i] = addr.String()
	}
	body, err := json.Marshal(ips)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

// parseBatch returns the successful results; cacheable is false when the
// request itself failed, so a retry is allowed later.
func parseBatch(data []byte, err error) (map[netip.Addr]Geo, bool) {
	if err != nil {
		return nil, false
	}
	var entries []geoEntry
	if json.Unmarshal(data, &entries) != nil {
		return nil, false
	}
	out := map[netip.Addr]Geo{}
	for _, e := range entries {
		addr, err := netip.ParseAddr(e.Query)
		if err != nil || e.Status != "success" {
			continue
		}
		out[addr.Unmap()] = e.geo()
	}
	return out, true
}

// resolve completes every call in batch.
func (a *IPAPI) resolve(batch []netip.Addr, results map[netip.Addr]Geo, cacheable bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.cache) >= cacheCap {
		a.cache = map[netip.Addr]*call{}
	}
	for _, addr := range batch {
		c := a.pending[addr]
		delete(a.pending, addr)
		if g, ok := results[addr]; ok {
			c.geo, c.ok = g, true
		}
		if cacheable {
			a.cache[addr] = c
		}
		close(c.done)
	}
}

// failPending completes every unresolved call empty once the sender stops.
func (a *IPAPI) failPending() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for addr, c := range a.pending {
		delete(a.pending, addr)
		close(c.done)
	}
	a.queue = nil
}

type geoEntry struct {
	Status      string  `json:"status"`
	Query       string  `json:"query"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	City        string  `json:"city"`
	CountryCode string  `json:"countryCode"`
}

func (e geoEntry) geo() Geo {
	return Geo{Lat: e.Lat, Lon: e.Lon, City: capField(e.City), CountryCode: capField(e.CountryCode)}
}

// Self returns this machine's public IP and location (ip-api /json), subject
// to the same rate limit as batches.
func (a *IPAPI) Self(ctx context.Context) (netip.Addr, Geo, bool) {
	data, err := a.do(ctx, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.SelfURL, nil)
	})
	if err != nil {
		return netip.Addr{}, Geo{}, false
	}
	var e geoEntry
	if json.Unmarshal(data, &e) != nil || e.Status != "success" {
		return netip.Addr{}, Geo{}, false
	}
	addr, err := netip.ParseAddr(e.Query)
	if err != nil {
		return netip.Addr{}, Geo{}, false
	}
	return addr.Unmap(), e.geo(), true
}

var errRateLimited = errors.New("ipapi: rate limited")

// do waits for a turn, performs the request under requestTimeout, records
// X-Rl/X-Ttl, and retries once after a 429 block. It returns the 200 body.
// build runs only once the request may start.
func (a *IPAPI) do(ctx context.Context, build func(context.Context) (*http.Request, error)) ([]byte, error) {
	for attempt := 0; attempt < 2; attempt++ {
		if err := a.waitTurn(ctx); err != nil {
			return nil, err
		}
		retry, data, err := a.attempt(ctx, build)
		if !retry {
			return data, err
		}
	}
	return nil, errRateLimited
}

// attempt performs one request in a turn already granted by waitTurn.
func (a *IPAPI) attempt(ctx context.Context, build func(context.Context) (*http.Request, error)) (retry bool, data []byte, err error) {
	ctx, cancel := withTimeout(ctx, a.cfg.Clock, requestTimeout)
	defer cancel()
	req, err := build(ctx)
	if err != nil {
		a.finishRequest(nil)
		return false, nil, err
	}
	resp, err := a.cfg.HTTP.Do(req)
	if err != nil {
		a.finishRequest(nil)
		return false, nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes))
	resp.Body.Close()
	a.finishRequest(resp)
	switch {
	case resp.StatusCode == http.StatusTooManyRequests:
		return true, nil, nil
	case resp.StatusCode != http.StatusOK:
		return false, nil, errors.New("ipapi: status " + strconv.Itoa(resp.StatusCode))
	case readErr != nil:
		return false, nil, readErr
	default:
		return false, data, nil
	}
}

// waitTurn blocks until a request may start: no X-Rl/429 block is active and
// the token bucket has a token for it. The token is reserved once and held
// while blocks are waited out, and the block is re-checked after every sleep.
// On success the request counts as in flight until finishRequest.
func (a *IPAPI) waitTurn(ctx context.Context) error {
	clk := a.cfg.Clock
	var r *rate.Reservation
	for {
		now := clk.Now()
		a.mu.Lock()
		if until := a.blockedUntil; now.Before(until) {
			a.mu.Unlock()
			if err := sleep(ctx, clk, until.Sub(now)); err != nil {
				cancelReservation(r, clk)
				return err
			}
			continue
		}
		if r == nil {
			r = a.limiter.ReserveN(now, 1)
		}
		if d := r.DelayFrom(now); d > 0 {
			a.mu.Unlock()
			if err := sleep(ctx, clk, d); err != nil {
				cancelReservation(r, clk)
				return err
			}
			continue
		}
		a.startRequestLocked(now)
		a.mu.Unlock()
		return nil
	}
}

func cancelReservation(r *rate.Reservation, clk Clock) {
	if r != nil {
		r.CancelAt(clk.Now())
	}
}

// startRequestLocked counts a request against the last known X-Rl budget.
func (a *IPAPI) startRequestLocked(now time.Time) {
	a.inflightReqs++
	if now.Before(a.rlReset) {
		a.rlLeft--
		if a.rlLeft <= 0 {
			a.blockUntilLocked(a.rlReset)
		}
	}
}

// finishRequest records a response's rate-limit headers (resp may be nil when
// the request failed). Requests still in flight were sent before this reply
// and may not be counted in its X-Rl yet, so they are subtracted from it.
func (a *IPAPI) finishRequest(resp *http.Response) {
	now := a.cfg.Clock.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.inflightReqs--
	if resp == nil {
		return
	}
	ttl := headerSeconds(resp, "X-Ttl", defaultBlock)
	if resp.StatusCode == http.StatusTooManyRequests {
		a.blockUntilLocked(now.Add(ttl))
		return
	}
	rl, err := strconv.Atoi(resp.Header.Get("X-Rl"))
	if err != nil {
		return
	}
	left := rl - a.inflightReqs
	if left <= 0 {
		a.blockUntilLocked(now.Add(ttl))
		return
	}
	a.rlLeft, a.rlReset = left, now.Add(ttl)
}

func (a *IPAPI) blockUntilLocked(until time.Time) {
	if until.After(a.blockedUntil) {
		a.blockedUntil = until
	}
}

func sleep(ctx context.Context, clk Clock, d time.Duration) error {
	select {
	case <-clk.After(d):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func headerSeconds(resp *http.Response, name string, def time.Duration) time.Duration {
	if n, err := strconv.Atoi(resp.Header.Get(name)); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return def
}
