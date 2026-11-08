package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// guard timeout only bounds a hung test; no test waits on it in the green path.
const testTimeout = 5 * time.Second

type fakeSource func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error

func (f fakeSource) Trace(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
	return f(ctx, target, emit)
}

func validateExceptBad(target string) error {
	if target == "bad;target" {
		return errors.New("nope")
	}
	return nil
}

type harness struct {
	t      *testing.T
	port   int
	srv    *httptest.Server
	cancel context.CancelFunc
	ctx    context.Context
}

func newHarness(t *testing.T, src TraceSource) *harness {
	t.Helper()
	srv := httptest.NewUnstartedServer(nil)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	h, err := New(Config{Port: port, Source: src, Validate: validateExceptBad})
	if err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = h
	srv.Start()
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	t.Cleanup(cancel)
	return &harness{t: t, port: port, srv: srv, ctx: ctx, cancel: cancel}
}

func (h *harness) dial() *websocket.Conn {
	h.t.Helper()
	hdr := http.Header{}
	hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(h.port))
	c, _, err := websocket.Dial(h.ctx, "ws://127.0.0.1:"+strconv.Itoa(h.port)+"/ws", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	h.t.Cleanup(func() { c.CloseNow() })
	return c
}

func (h *harness) send(c *websocket.Conn, raw string) {
	h.t.Helper()
	if err := c.Write(h.ctx, websocket.MessageText, []byte(raw)); err != nil {
		h.t.Fatalf("write: %v", err)
	}
}

func (h *harness) recv(c *websocket.Conn) protocol.ServerMsg {
	h.t.Helper()
	_, data, err := c.Read(h.ctx)
	if err != nil {
		h.t.Fatalf("read: %v", err)
	}
	m, err := protocol.DecodeServer(data)
	if err != nil {
		h.t.Fatalf("decode %s: %v", data, err)
	}
	return m
}

func hop(ttl int) protocol.Hop {
	return protocol.Hop{TTL: ttl, GeoSource: protocol.GeoEstimated}
}

func TestStartedIsSentBeforeHops(t *testing.T) {
	src := fakeSource(func(_ context.Context, target string, emit func(protocol.ServerMsg)) error {
		emit(hop(1)) // enrichment raced ahead of the origin lookup
		emit(hop(2))
		emit(protocol.TraceStarted{Target: target})
		emit(hop(3))
		emit(protocol.TraceDone{Reached: true})
		return nil
	})
	h := newHarness(t, src)
	c := h.dial()
	h.send(c, `{"type":"trace.start","target":"example.com"}`)

	if m, ok := h.recv(c).(protocol.TraceStarted); !ok || m.Target != "example.com" {
		t.Fatalf("first message must be trace.started, got %#v", m)
	}
	for ttl := 1; ttl <= 3; ttl++ {
		if m, ok := h.recv(c).(protocol.Hop); !ok || m.TTL != ttl {
			t.Fatalf("want hop %d, got %#v", ttl, m)
		}
	}
	if _, ok := h.recv(c).(protocol.TraceDone); !ok {
		t.Fatal("want trace.done last")
	}
}

func TestSourceNeverStartingStillFlushesBufferedEvents(t *testing.T) {
	src := fakeSource(func(_ context.Context, _ string, emit func(protocol.ServerMsg)) error {
		emit(protocol.Error{Code: protocol.ErrTracerouteMissing, Message: "no traceroute"})
		return nil
	})
	h := newHarness(t, src)
	c := h.dial()
	h.send(c, `{"type":"trace.start","target":"example.com"}`)
	if m, ok := h.recv(c).(protocol.Error); !ok || m.Code != protocol.ErrTracerouteMissing {
		t.Fatalf("got %#v", m)
	}
}

func TestInvalidTargetIsRejectedWithoutStartingTrace(t *testing.T) {
	called := make(chan struct{}, 1)
	src := fakeSource(func(context.Context, string, func(protocol.ServerMsg)) error {
		called <- struct{}{}
		return nil
	})
	h := newHarness(t, src)
	c := h.dial()
	h.send(c, `{"type":"trace.start","target":"bad;target"}`)
	m, ok := h.recv(c).(protocol.Error)
	if !ok || m.Code != protocol.ErrInvalidTarget {
		t.Fatalf("got %#v", m)
	}
	if m.Message == "" || m.Message == "bad;target" {
		t.Fatalf("message should be a fixed description, got %q", m.Message)
	}
	select {
	case <-called:
		t.Fatal("source must not run for an invalid target")
	default:
	}
}

func TestBadMessagesGetErrorAndConnectionSurvives(t *testing.T) {
	src := fakeSource(func(_ context.Context, target string, emit func(protocol.ServerMsg)) error {
		emit(protocol.TraceStarted{Target: target})
		return nil
	})
	h := newHarness(t, src)
	c := h.dial()
	for _, raw := range []string{`not json`, `{"type":"hop"}`, `{"type":"trace.start","target":1}`, `{"type":"trace.start","target":"a","x":1}`, `[]`} {
		h.send(c, raw)
		if m, ok := h.recv(c).(protocol.Error); !ok || m.Code != protocol.ErrBadMessage {
			t.Fatalf("%s: got %#v", raw, m)
		}
	}
	if err := c.Write(h.ctx, websocket.MessageBinary, []byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	if m, ok := h.recv(c).(protocol.Error); !ok || m.Code != protocol.ErrBadMessage {
		t.Fatalf("binary: got %#v", m)
	}
	h.send(c, `{"type":"trace.start","target":"ok.example"}`)
	if _, ok := h.recv(c).(protocol.TraceStarted); !ok {
		t.Fatal("connection should still work after bad messages")
	}
}

func TestOversizeMessageClosesConnection(t *testing.T) {
	h := newHarness(t, fakeSource(func(context.Context, string, func(protocol.ServerMsg)) error { return nil }))
	c := h.dial()
	big := make([]byte, readLimit+1)
	for i := range big {
		big[i] = 'a'
	}
	_ = c.Write(h.ctx, websocket.MessageText, big)
	_, _, err := c.Read(h.ctx)
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("want close 1009, got %v", err)
	}
}

func TestSecondStartCancelsFirstAndDropsItsStaleEvents(t *testing.T) {
	aRunning := make(chan struct{})
	aCancelled := make(chan struct{})
	src := fakeSource(func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
		if target == "a.example" {
			emit(protocol.TraceStarted{Target: target})
			close(aRunning)
			<-ctx.Done()
			emit(hop(9)) // stale: must never reach the client
			close(aCancelled)
			return ctx.Err()
		}
		<-aCancelled // second trace begins only after the first fully stopped
		emit(protocol.TraceStarted{Target: target})
		emit(protocol.TraceDone{Reached: true})
		return nil
	})
	h := newHarness(t, src)
	c := h.dial()
	h.send(c, `{"type":"trace.start","target":"a.example"}`)
	if m, ok := h.recv(c).(protocol.TraceStarted); !ok || m.Target != "a.example" {
		t.Fatalf("got %#v", m)
	}
	<-aRunning
	h.send(c, `{"type":"trace.start","target":"b.example"}`)
	if m, ok := h.recv(c).(protocol.TraceStarted); !ok || m.Target != "b.example" {
		t.Fatalf("want b's trace.started (no stale a events), got %#v", m)
	}
	if _, ok := h.recv(c).(protocol.TraceDone); !ok {
		t.Fatal("want b's trace.done")
	}
}

func TestCancelAndDisconnectTearDownTrace(t *testing.T) {
	for _, tc := range []struct {
		name string
		stop func(h *harness, c *websocket.Conn)
	}{
		{"trace.cancel", func(h *harness, c *websocket.Conn) { h.send(c, `{"type":"trace.cancel"}`) }},
		{"disconnect", func(_ *harness, c *websocket.Conn) { c.CloseNow() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			running := make(chan struct{})
			stopped := make(chan struct{})
			src := fakeSource(func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
				emit(protocol.TraceStarted{Target: target})
				close(running)
				<-ctx.Done()
				close(stopped)
				return ctx.Err()
			})
			h := newHarness(t, src)
			c := h.dial()
			h.send(c, `{"type":"trace.start","target":"example.com"}`)
			h.recv(c)
			<-running
			tc.stop(h, c)
			select {
			case <-stopped:
			case <-h.ctx.Done():
				t.Fatal("trace context was not cancelled")
			}
		})
	}
}

func TestSourceFailureWithoutErrorEventReportsTracerouteFailed(t *testing.T) {
	src := fakeSource(func(context.Context, string, func(protocol.ServerMsg)) error { return errors.New("boom") })
	h := newHarness(t, src)
	c := h.dial()
	h.send(c, `{"type":"trace.start","target":"example.com"}`)
	m, ok := h.recv(c).(protocol.Error)
	if !ok || m.Code != protocol.ErrTracerouteFailed {
		t.Fatalf("got %#v", m)
	}
}

func TestWSRejectsBadOriginAndHostWith403(t *testing.T) {
	h := newHarness(t, fakeSource(func(context.Context, string, func(protocol.ServerMsg)) error { return nil }))
	base := "ws://127.0.0.1:" + strconv.Itoa(h.port) + "/ws"
	for _, origin := range []string{"http://evil.com", "https://lightpath.blackpaw.studio.evil.com", "null", ""} {
		hdr := http.Header{}
		if origin != "" {
			hdr.Set("Origin", origin)
		}
		_, resp, err := websocket.Dial(h.ctx, base, &websocket.DialOptions{HTTPHeader: hdr})
		if err == nil {
			t.Fatalf("origin %q was accepted", origin)
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("origin %q: want 403, got %v", origin, resp)
		}
	}
	// Hosted origin is accepted.
	hdr := http.Header{}
	hdr.Set("Origin", "https://lightpath.blackpaw.studio")
	c, _, err := websocket.Dial(h.ctx, base, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("hosted origin rejected: %v", err)
	}
	c.CloseNow()
	// DNS rebinding: wrong Host with a good Origin.
	hdr = http.Header{}
	hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(h.port))
	r, _ := http.NewRequestWithContext(h.ctx, http.MethodGet, h.srv.URL+"/ws", nil)
	r.Host = "evil.com:" + strconv.Itoa(h.port)
	r.Header = hdr
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("rebinding host: got %d", resp.StatusCode)
	}
}

func TestNewValidatesConfig(t *testing.T) {
	src := fakeSource(func(context.Context, string, func(protocol.ServerMsg)) error { return nil })
	for name, cfg := range map[string]Config{
		"no port":      {Source: src, Validate: validateExceptBad},
		"no source":    {Port: 1, Validate: validateExceptBad},
		"no validator": {Port: 1, Source: src},
	} {
		if _, err := New(cfg); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}
