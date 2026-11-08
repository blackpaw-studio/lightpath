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
	ipAPIFields   = "status,message,query,lat,lon,city,countryCode"
	batchURL      = "http://ip-api.com/batch?fields=" + ipAPIFields
	selfURL       = "http://ip-api.com/json/?fields=" + ipAPIFields
	batchWindow   = 250 * time.Millisecond
	maxBatch      = 100
	requestsPerIv = 15 // ip-api free tier: 15 requests per minute per IP
	rateInterval  = time.Minute
	defaultBlock  = time.Minute // wait when a 429 carries no X-Ttl
	maxRespBytes  = 1 << 20
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

// IPAPI geolocates public IPs through ip-api.com. Lookups are coalesced into
// batches (≤100 IPs, flushed after 250 ms), sent through a 15 req/min token
// bucket, and paused whenever the server reports X-Rl: 0. Results (including
// "fail" results) are cached for the lifetime of the value, which is longer
// than one run on purpose: it conserves the shared rate-limit budget.
type IPAPI struct {
	cfg     IPAPIConfig
	limiter *rate.Limiter
	ctx     context.Context
	cancel  context.CancelFunc

	mu           sync.Mutex
	cache        map[netip.Addr]*call // completed
	inflight     map[netip.Addr]*call // queued or in a request
	queue        []netip.Addr
	gen          int
	blockedUntil time.Time
}

// NewIPAPI returns a client. Call Close to stop background work.
func NewIPAPI(cfg IPAPIConfig) *IPAPI {
	if cfg.BatchURL == "" {
		cfg.BatchURL = batchURL
	}
	if cfg.SelfURL == "" {
		cfg.SelfURL = selfURL
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &IPAPI{
		cfg:      cfg,
		limiter:  rate.NewLimiter(rate.Every(rateInterval/requestsPerIv), requestsPerIv),
		ctx:      ctx,
		cancel:   cancel,
		cache:    map[netip.Addr]*call{},
		inflight: map[netip.Addr]*call{},
	}
}

// Close cancels in-flight and queued work; pending lookups return empty.
func (a *IPAPI) Close() { a.cancel() }

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
		return Geo{}, false
	}
}

// enqueue returns the call for addr: cached, already in flight, or newly queued.
func (a *IPAPI) enqueue(addr netip.Addr) *call {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.cache[addr]; ok {
		return c
	}
	if c, ok := a.inflight[addr]; ok {
		return c
	}
	c := &call{done: make(chan struct{})}
	a.inflight[addr] = c
	a.queue = append(a.queue, addr)
	switch {
	case len(a.queue) >= maxBatch:
		batch := a.takeLocked()
		go a.send(batch)
	case len(a.queue) == 1:
		go a.flushAfter(a.gen)
	}
	return c
}

// takeLocked removes and returns the queue, invalidating its window timer.
func (a *IPAPI) takeLocked() []netip.Addr {
	batch := a.queue
	a.queue = nil
	a.gen++
	return batch
}

func (a *IPAPI) flushAfter(gen int) {
	select {
	case <-a.cfg.Clock.After(batchWindow):
	case <-a.ctx.Done():
	}
	a.mu.Lock()
	if a.gen != gen || len(a.queue) == 0 {
		a.mu.Unlock()
		return
	}
	batch := a.takeLocked()
	a.mu.Unlock()
	a.send(batch)
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
	return Geo{Lat: e.Lat, Lon: e.Lon, City: e.City, CountryCode: e.CountryCode}
}

// send performs one batch request and resolves every call in it.
func (a *IPAPI) send(batch []netip.Addr) {
	results, cacheable := a.fetchBatch(batch)
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.cache) >= cacheCap {
		a.cache = map[netip.Addr]*call{}
	}
	for _, addr := range batch {
		c := a.inflight[addr]
		delete(a.inflight, addr)
		if g, ok := results[addr]; ok {
			c.geo, c.ok = g, true
		}
		if cacheable {
			a.cache[addr] = c
		}
		close(c.done)
	}
}

// fetchBatch returns the successful results; cacheable is false when the
// request itself failed, so a retry is allowed later.
func (a *IPAPI) fetchBatch(batch []netip.Addr) (map[netip.Addr]Geo, bool) {
	ips := make([]string, len(batch))
	for i, addr := range batch {
		ips[i] = addr.String()
	}
	body, _ := json.Marshal(ips)
	data, err := a.do(a.ctx, func(ctx context.Context) (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.BatchURL, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
		}
		return req, err
	})
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

// do waits for a rate-limit slot, performs the request, records X-Rl/X-Ttl,
// and retries once after a 429 block. It returns the 200 body.
func (a *IPAPI) do(ctx context.Context, build func(context.Context) (*http.Request, error)) ([]byte, error) {
	for attempt := 0; attempt < 2; attempt++ {
		if err := a.waitTurn(ctx); err != nil {
			return nil, err
		}
		req, err := build(ctx)
		if err != nil {
			return nil, err
		}
		resp, err := a.cfg.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes))
		resp.Body.Close()
		a.noteHeaders(resp)
		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			a.blockFor(headerSeconds(resp, "X-Ttl", defaultBlock))
		case resp.StatusCode != http.StatusOK:
			return nil, errors.New("ipapi: status " + strconv.Itoa(resp.StatusCode))
		case readErr != nil:
			return nil, readErr
		default:
			return data, nil
		}
	}
	return nil, errRateLimited
}

// waitTurn blocks until neither an X-Rl block nor the token bucket forbids a request.
func (a *IPAPI) waitTurn(ctx context.Context) error {
	clk := a.cfg.Clock
	for {
		now := clk.Now()
		a.mu.Lock()
		until := a.blockedUntil
		a.mu.Unlock()
		if now.Before(until) {
			if err := sleep(ctx, clk, until.Sub(now)); err != nil {
				return err
			}
			continue
		}
		r := a.limiter.ReserveN(now, 1)
		d := r.DelayFrom(now)
		if d <= 0 {
			return nil
		}
		if err := sleep(ctx, clk, d); err != nil {
			r.CancelAt(now)
			return err
		}
		return nil
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

func (a *IPAPI) noteHeaders(resp *http.Response) {
	if resp.StatusCode == http.StatusTooManyRequests {
		return
	}
	if rl, err := strconv.Atoi(resp.Header.Get("X-Rl")); err == nil && rl <= 0 {
		a.blockFor(headerSeconds(resp, "X-Ttl", defaultBlock))
	}
}

func (a *IPAPI) blockFor(d time.Duration) {
	until := a.cfg.Clock.Now().Add(d)
	a.mu.Lock()
	if until.After(a.blockedUntil) {
		a.blockedUntil = until
	}
	a.mu.Unlock()
}

func headerSeconds(resp *http.Response, name string, def time.Duration) time.Duration {
	if n, err := strconv.Atoi(resp.Header.Get(name)); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return def
}
