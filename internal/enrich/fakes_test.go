package enrich

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock is a manually advanced Clock. Timers fire only on Advance.
type fakeClock struct {
	mu      sync.Mutex
	cond    *sync.Cond
	now     time.Time
	waiters []*fakeWaiter
}

type fakeWaiter struct {
	at    time.Time
	dur   time.Duration
	ch    chan time.Time
	fired bool
}

func newFakeClock() *fakeClock {
	c := &fakeClock{now: time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	ch, _ := c.Timer(d)
	return ch
}

// Timer registers a timer; stop removes it from the pending set.
func (c *fakeClock) Timer(d time.Duration) (<-chan time.Time, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w := &fakeWaiter{at: c.now.Add(d), dur: d, ch: make(chan time.Time, 1)}
	if d <= 0 {
		w.fired = true
		w.ch <- c.now
	}
	c.waiters = append(c.waiters, w)
	c.cond.Broadcast()
	return w.ch, func() {
		c.mu.Lock()
		w.fired = true
		c.mu.Unlock()
	}
}

// Advance moves time forward and fires every timer that is now due.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	for _, w := range c.waiters {
		if !w.fired && !w.at.After(c.now) {
			w.fired = true
			w.ch <- c.now
		}
	}
}

func (c *fakeClock) pending(d time.Duration) int {
	n := 0
	for _, w := range c.waiters {
		if !w.fired && w.dur == d {
			n++
		}
	}
	return n
}

// Await blocks until a pending timer of duration d exists.
func (c *fakeClock) Await(t *testing.T, d time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for c.pending(d) == 0 {
			c.cond.Wait()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("no timer of %v was ever registered", d)
	}
}

// AwaitOther blocks until a pending timer whose duration is not in ignore
// exists, and returns that duration.
func (c *fakeClock) AwaitOther(t *testing.T, ignore ...time.Duration) time.Duration {
	t.Helper()
	found := make(chan time.Duration, 1)
	go func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for {
			for _, w := range c.waiters {
				if w.fired {
					continue
				}
				skip := false
				for _, d := range ignore {
					skip = skip || w.dur == d
				}
				if !skip {
					found <- w.dur
					return
				}
			}
			c.cond.Wait()
		}
	}()
	select {
	case d := <-found:
		return d
	case <-time.After(5 * time.Second):
		t.Fatal("no unexpected timer was ever registered")
		return 0
	}
}

// fakeTXT resolves TXT names from a map; names in block hang until ctx ends.
type fakeTXT struct {
	mu      sync.Mutex
	records map[string][]string
	err     map[string]error
	block   bool
	calls   []string
}

func (f *fakeTXT) LookupTXT(ctx context.Context, name string) ([]string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	rec, errv, block := f.records[name], f.err[name], f.block
	f.mu.Unlock()
	if block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if errv != nil {
		return nil, errv
	}
	if rec == nil {
		return nil, errNXDomain(name)
	}
	return rec, nil
}

func (f *fakeTXT) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// fakeHTTP records requests and answers via fn.
type fakeHTTP struct {
	mu   sync.Mutex
	reqs []recordedReq
	fn   func(r recordedReq) (*http.Response, error)
	seen chan recordedReq
}

type recordedReq struct {
	Method string
	URL    string
	Body   string
	Ctx    context.Context
}

func newFakeHTTP(fn func(r recordedReq) (*http.Response, error)) *fakeHTTP {
	return &fakeHTTP{fn: fn, seen: make(chan recordedReq, 64)}
}

func (f *fakeHTTP) Do(req *http.Request) (*http.Response, error) {
	var body string
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		body = string(b)
	}
	rr := recordedReq{Method: req.Method, URL: req.URL.String(), Body: body, Ctx: req.Context()}
	f.mu.Lock()
	f.reqs = append(f.reqs, rr)
	f.mu.Unlock()
	f.seen <- rr
	return f.fn(rr)
}

func (f *fakeHTTP) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

func (f *fakeHTTP) next(t *testing.T) recordedReq {
	t.Helper()
	select {
	case r := <-f.seen:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("expected an HTTP request that never came")
		return recordedReq{}
	}
}

func httpResp(status int, body string, hdr map[string]string) *http.Response {
	h := http.Header{}
	for k, v := range hdr {
		h.Set(k, v)
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
}
