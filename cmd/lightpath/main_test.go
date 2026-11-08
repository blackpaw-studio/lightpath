package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"github.com/blackpaw-studio/lightpath/internal/replay"
	"github.com/blackpaw-studio/lightpath/internal/server"
)

const fixturePath = "../../internal/replay/testdata/tiny.json"

const testTimeout = 5 * time.Second // bounds a hung test only

// instantClock makes replay offsets elapse immediately.
type instantClock struct{}

func (instantClock) Now() time.Time { return time.Date(2026, 11, 7, 22, 0, 0, 0, time.UTC) }
func (instantClock) After(time.Duration) <-chan time.Time {
	c := make(chan time.Time, 1)
	c <- time.Time{}
	return c
}

type recorder struct {
	mu     sync.Mutex
	opened []string
}

func (r *recorder) open(u string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.opened = append(r.opened, u)
	return nil
}

func testDeps(errOut io.Writer) (deps, *recorder) {
	rec := &recorder{}
	return deps{
		stderr:      errOut,
		listen:      net.Listen,
		openBrowser: rec.open,
		clock:       instantClock{},
		static:      fstest.MapFS{"index.html": {Data: []byte("<h1>ui</h1>")}},
		live: func(context.Context) (server.TraceSource, server.Validator, error) {
			return nil, nil, errors.New("live mode not under test")
		},
		writeFile: func(string, []byte) error { return nil },
	}, rec
}

func TestParseFlags(t *testing.T) {
	got, err := parseFlags(nil, io.Discard)
	if err != nil || got != (options{port: 47800}) {
		t.Fatalf("defaults: %+v %v", got, err)
	}
	got, err = parseFlags([]string{"--port", "5000", "--replay", "a.json", "--record", "b.json", "--no-open"}, io.Discard)
	want := options{port: 5000, replay: "a.json", record: "b.json", noOpen: true}
	if err != nil || got != want {
		t.Fatalf("overrides: %+v %v", got, err)
	}
	for _, args := range [][]string{{"--port", "-1"}, {"--port", "65536"}, {"--port", "x"}, {"extra"}, {"--bogus"}} {
		if _, err := parseFlags(args, io.Discard); err == nil {
			t.Errorf("%v: expected error", args)
		}
	}
}

func TestStartServesReplayOnLoopbackOnly(t *testing.T) {
	d, opened := testDeps(io.Discard)
	a, err := start(context.Background(), options{replay: fixturePath, noOpen: true}, d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.ln.Close() })
	addr := a.ln.Addr().(*net.TCPAddr)
	if !addr.IP.IsLoopback() {
		t.Fatalf("listener %v is not loopback", addr)
	}
	if len(opened.opened) != 0 {
		t.Fatalf("--no-open must not open a browser: %v", opened.opened)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.serve(ctx, cancel) }()

	resp, err := http.Get("http://" + addr.String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "ui") {
		t.Fatalf("GET /: %d %q", resp.StatusCode, body)
	}
	req, _ := http.NewRequest(http.MethodGet, "http://"+addr.String()+"/", nil)
	req.Host = "evil.example:" + strconv.Itoa(addr.Port)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("rebinding Host: %d", resp.StatusCode)
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("serve: %v", err)
	}
}

func TestStartOpensBrowserAtLoopbackURL(t *testing.T) {
	d, opened := testDeps(io.Discard)
	a, err := start(context.Background(), options{replay: fixturePath}, d)
	if err != nil {
		t.Fatal(err)
	}
	defer a.ln.Close()
	want := "http://127.0.0.1:" + strconv.Itoa(a.ln.Addr().(*net.TCPAddr).Port) + "/"
	if len(opened.opened) != 1 || opened.opened[0] != want {
		t.Fatalf("opened %v, want [%s]", opened.opened, want)
	}
}

func TestBrowserOpenFailureIsNotFatal(t *testing.T) {
	var errOut bytes.Buffer
	d, _ := testDeps(&errOut)
	d.openBrowser = func(string) error { return errors.New("no display") }
	a, err := start(context.Background(), options{replay: fixturePath}, d)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer a.ln.Close()
	if !strings.Contains(errOut.String(), "no display") {
		t.Fatalf("expected a warning, got %q", errOut.String())
	}
}

func TestLiveModeBuildsSourceWithAppContext(t *testing.T) {
	d, _ := testDeps(io.Discard)
	got := make(chan context.Context, 1)
	d.live = func(ctx context.Context) (server.TraceSource, server.Validator, error) {
		got <- ctx
		return traceFunc(func(context.Context, string, func(protocol.ServerMsg)) error { return nil }),
			func(string) error { return nil }, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- run(ctx, []string{"--no-open", "--port", "0"}, d) }()
	liveCtx := <-got
	if liveCtx.Err() != nil {
		t.Fatal("live context must stay open while the agent runs")
	}
	cancel()
	if err := <-runDone; err != nil {
		t.Fatalf("run: %v", err)
	}
	if liveCtx.Err() == nil {
		t.Error("live context must end when the agent stops")
	}
}

func TestLiveModeErrorFailsBeforeListening(t *testing.T) {
	d, _ := testDeps(io.Discard)
	d.listen = func(string, string) (net.Listener, error) { t.Fatal("must not listen"); return nil, nil }
	if _, err := start(context.Background(), options{noOpen: true}, d); err == nil {
		t.Fatal("expected the live builder's error")
	}
}

func TestMissingReplayFileFailsBeforeListening(t *testing.T) {
	d, _ := testDeps(io.Discard)
	d.listen = func(string, string) (net.Listener, error) { t.Fatal("must not listen"); return nil, nil }
	if _, err := start(context.Background(), options{replay: "testdata/nope.json"}, d); err == nil {
		t.Fatal("expected error")
	}
}

func TestPortInUseGivesClearError(t *testing.T) {
	d, _ := testDeps(io.Discard)
	first, err := start(context.Background(), options{replay: fixturePath, noOpen: true}, d)
	if err != nil {
		t.Fatal(err)
	}
	defer first.ln.Close()
	port := first.ln.Addr().(*net.TCPAddr).Port
	_, err = start(context.Background(), options{replay: fixturePath, noOpen: true, port: port}, d)
	if err == nil || !strings.Contains(err.Error(), "in use") || !strings.Contains(err.Error(), strconv.Itoa(port)) {
		t.Fatalf("got %v", err)
	}
}

type stubListener struct{ addr net.Addr }

func (l stubListener) Accept() (net.Conn, error) { return nil, errors.New("stub") }
func (l stubListener) Close() error              { return nil }
func (l stubListener) Addr() net.Addr            { return l.addr }

func TestNonLoopbackListenerIsRejected(t *testing.T) {
	d, _ := testDeps(io.Discard)
	d.listen = func(string, string) (net.Listener, error) {
		return stubListener{&net.TCPAddr{IP: net.IPv4zero, Port: 47800}}, nil
	}
	if _, err := start(context.Background(), options{replay: fixturePath, noOpen: true}, d); err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("got %v", err)
	}
}

func TestReplayStreamsOverWebSocketAndRecords(t *testing.T) {
	d, _ := testDeps(io.Discard)
	saved := make(chan []byte, 1)
	d.writeFile = func(path string, data []byte) error {
		if path != "out.json" {
			t.Errorf("record path %q", path)
		}
		saved <- data
		return nil
	}
	a, err := start(context.Background(), options{replay: fixturePath, record: "out.json", noOpen: true}, d)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	go a.serve(ctx, cancel)
	port := a.ln.Addr().(*net.TCPAddr).Port

	hdr := http.Header{}
	hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(port))
	c, _, err := websocket.Dial(ctx, "ws://127.0.0.1:"+strconv.Itoa(port)+"/ws", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	// Any target is accepted in replay mode and ignored.
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"trace.start","target":"anything at all"}`)); err != nil {
		t.Fatal(err)
	}
	var types []string
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		m, err := protocol.DecodeServer(data)
		if err != nil {
			t.Fatal(err)
		}
		switch m.(type) {
		case protocol.TraceStarted:
			types = append(types, "started")
		case protocol.Hop:
			types = append(types, "hop")
		case protocol.HopUpdate:
			types = append(types, "update")
		case protocol.TraceDone:
			types = append(types, "done")
		}
		if len(types) > 0 && types[len(types)-1] == "done" {
			break
		}
	}
	if got := strings.Join(types, ","); got != "started,hop,hop,hop,update,done" {
		t.Fatalf("stream: %s", got)
	}
	select {
	case data := <-saved:
		f, err := replay.Load(bytes.NewReader(data))
		if err != nil || len(f.Events) != 6 {
			t.Fatalf("recording: %v %+v", err, f)
		}
	case <-ctx.Done():
		t.Fatal("recording was not written")
	}
}

func TestRunHelpIsNotAnError(t *testing.T) {
	d, _ := testDeps(io.Discard)
	if err := run(context.Background(), []string{"-h"}, d); err != nil {
		t.Fatalf("got %v", err)
	}
}

func TestShutdownCancelsActiveTraceAndWaitsForIt(t *testing.T) {
	d, _ := testDeps(io.Discard)
	started := make(chan struct{})
	sawCancel := make(chan struct{})
	returned := make(chan struct{})
	src := traceFunc(func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
		defer close(returned)
		emit(protocol.TraceStarted{Target: target})
		close(started)
		<-ctx.Done()
		close(sawCancel)
		return ctx.Err()
	})
	d.live = func(context.Context) (server.TraceSource, server.Validator, error) {
		return src, func(string) error { return nil }, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d.listen = func(string, string) (net.Listener, error) { return ln, nil }
	port := ln.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	appCtx, stop := context.WithCancel(ctx)
	runDone := make(chan error, 1)
	go func() { runDone <- run(appCtx, []string{"--no-open"}, d) }()

	hdr := http.Header{}
	hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(port))
	c, _, err := websocket.Dial(ctx, "ws://127.0.0.1:"+strconv.Itoa(port)+"/ws", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"trace.start","target":"example.com"}`)); err != nil {
		t.Fatal(err)
	}
	<-started

	stop()
	if err := <-runDone; err != nil {
		t.Fatalf("run: %v", err)
	}
	select {
	case <-sawCancel:
	default:
		t.Fatal("source never saw ctx.Done")
	}
	select {
	case <-returned:
	default:
		t.Fatal("run returned before the trace source returned")
	}
}

type traceFunc func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error

func (f traceFunc) Trace(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
	return f(ctx, target, emit)
}

// If the listener dies under Serve, run must still cancel every session and
// wait for its trace before returning.
func TestServeErrorStillStopsAndWaitsForTraces(t *testing.T) {
	d, _ := testDeps(io.Discard)
	started := make(chan struct{})
	returned := make(chan struct{})
	src := traceFunc(func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
		defer close(returned)
		emit(protocol.TraceStarted{Target: target})
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	d.live = func(context.Context) (server.TraceSource, server.Validator, error) {
		return src, func(string) error { return nil }, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d.listen = func(string, string) (net.Listener, error) { return ln, nil }
	port := ln.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- run(ctx, []string{"--no-open"}, d) }()

	hdr := http.Header{}
	hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(port))
	c, _, err := websocket.Dial(ctx, "ws://127.0.0.1:"+strconv.Itoa(port)+"/ws", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"trace.start","target":"example.com"}`)); err != nil {
		t.Fatal(err)
	}
	<-started
	ln.Close() // Serve fails with a non-ErrServerClosed error

	select {
	case err := <-runDone:
		if err == nil {
			t.Error("run should report the Serve error")
		}
	case <-ctx.Done():
		t.Fatal("run did not return")
	}
	select {
	case <-returned:
	default:
		t.Fatal("run returned before the trace source returned")
	}
}

// Smoke test from the plan: `lightpath --replay <fixture> --no-open` driven by
// a scripted ws client streams the fixture's events in order.
func TestReplaySmokeE2EFixtures(t *testing.T) {
	paths, err := filepath.Glob("../../ui/e2e/fixtures/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no e2e fixtures: %v", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			fx, err := replay.LoadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			d, _ := testDeps(io.Discard)
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			d.listen = func(string, string) (net.Listener, error) { return ln, nil }
			port := ln.Addr().(*net.TCPAddr).Port

			ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
			defer cancel()
			appCtx, stop := context.WithCancel(ctx)
			runDone := make(chan error, 1)
			go func() { runDone <- run(appCtx, []string{"--replay", path, "--no-open"}, d) }()

			hdr := http.Header{}
			hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(port))
			c, _, err := websocket.Dial(ctx, "ws://127.0.0.1:"+strconv.Itoa(port)+"/ws", &websocket.DialOptions{HTTPHeader: hdr})
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"trace.start","target":"anything.example"}`)); err != nil {
				t.Fatal(err)
			}
			for i, want := range fx.Events {
				_, data, err := c.Read(ctx)
				if err != nil {
					t.Fatalf("event %d: %v", i, err)
				}
				got, err := protocol.DecodeServer(data)
				if err != nil {
					t.Fatalf("event %d invalid: %v", i, err)
				}
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(want.Msg)
				if string(gotJSON) != string(wantJSON) {
					t.Fatalf("event %d:\n got %s\nwant %s", i, gotJSON, wantJSON)
				}
			}
			stop()
			if err := <-runDone; err != nil {
				t.Fatalf("run: %v", err)
			}
		})
	}
}
