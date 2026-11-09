package live_test

import (
	"context"
	"errors"
	"github.com/blackpaw-studio/lightpath/internal/reach"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/blackpaw-studio/lightpath/internal/enrich"
	"github.com/blackpaw-studio/lightpath/internal/live"
	"github.com/blackpaw-studio/lightpath/internal/protocol"
	"github.com/blackpaw-studio/lightpath/internal/server"
	"github.com/blackpaw-studio/lightpath/internal/target"
	"github.com/blackpaw-studio/lightpath/internal/trace"
)

const testTimeout = 5 * time.Second // bounds a hung test only

// script is fake traceroute output; hold keeps the process alive until killed.
type script struct {
	lines []string
	hold  bool
}

type fakeCmd struct {
	out    *io.PipeReader
	killed chan struct{}
	done   chan struct{}
}

func (c *fakeCmd) Output() io.Reader { return c.out }
func (c *fakeCmd) Wait() error {
	<-c.done
	select {
	case <-c.killed:
		return errors.New("signal: killed")
	default:
		return nil
	}
}

// fakeExec "runs" traceroute by writing the script for the argv's target.
func fakeExec(scripts map[string]script) trace.ExecFunc {
	return func(ctx context.Context, name string, args []string) (trace.Cmd, error) {
		sc := scripts[args[len(args)-1]]
		r, w := io.Pipe()
		c := &fakeCmd{out: r, killed: make(chan struct{}), done: make(chan struct{})}
		go func() {
			defer close(c.done)
			defer w.Close()
			for _, l := range sc.lines {
				if _, err := io.WriteString(w, l+"\n"); err != nil {
					return
				}
			}
			if sc.hold {
				<-ctx.Done()
				close(c.killed)
			}
		}()
		return c, nil
	}
}

const (
	ipA = "203.0.113.1"
	ipB = "198.51.100.7"
)

// hostLookup answers B at once; A's lookup outlives the trace and reports a
// result exactly as the trace is cancelled.
type hostLookup struct{}

func (hostLookup) Lookup(ctx context.Context, addr netip.Addr) (string, bool) {
	if addr.String() == ipB {
		return "be2.nyc.example.net", true
	}
	<-ctx.Done()
	return "late.a.example", true
}

type asnLookup struct{}

func (asnLookup) Lookup(context.Context, netip.Addr) (enrich.ASInfo, bool) {
	return enrich.ASInfo{ASN: 64500, Org: "EXAMPLE"}, true
}

type geoLookup struct{}

func (geoLookup) Lookup(context.Context, netip.Addr) (enrich.Geo, bool) {
	return enrich.Geo{Lat: 52.37, Lon: 4.9, City: "Amsterdam"}, true
}

func strp(s string) *string { return &s }

type originSource struct{}

var origin = protocol.Origin{PublicIP: strp("192.0.2.10"), City: strp("Toronto")}

func (originSource) Peek() protocol.Origin               { return origin }
func (originSource) Get(context.Context) protocol.Origin { return origin }

func newServer(t *testing.T, src server.TraceSource) (port int) {
	t.Helper()
	srv := httptest.NewUnstartedServer(nil)
	port = srv.Listener.Addr().(*net.TCPAddr).Port
	h, err := server.New(server.Config{Port: port, Source: src, Validate: target.Validate})
	if err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = h
	srv.Start()
	t.Cleanup(srv.Close)
	return port
}

func TestLiveSourceOverWebSocketRestartDropsOldTrace(t *testing.T) {
	scripts := map[string]script{
		"a.example": {hold: true, lines: []string{
			"traceroute to a.example (" + ipA + "), 64 hops max, 52 byte packets",
			" 1  " + ipA + "  1.100 ms  1.200 ms  1.300 ms",
		}},
		"b.example": {lines: []string{
			"traceroute to b.example (" + ipB + "), 64 hops max, 52 byte packets",
			" 1  " + ipB + "  4.100 ms  4.200 ms  4.300 ms",
		}},
	}
	enricher := enrich.New(enrich.Config{Host: hostLookup{}, ASN: asnLookup{}, Geo: geoLookup{}, Origin: originSource{}})
	src, err := live.New(live.Config{
		Runner:   trace.Runner{Exec: fakeExec(scripts)},
		Command:  func(tgt string) (string, []string) { return target.CommandFor(tgt, "linux") },
		Enricher: enricher,
		Origin:   originSource{},
		Reach:    noReach{},
		Clock:    enrich.RealClock,
	})
	if err != nil {
		t.Fatal(err)
	}
	port := newServer(t, src)

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	hdr := http.Header{}
	hdr.Set("Origin", "http://127.0.0.1:"+strconv.Itoa(port))
	c, _, err := websocket.Dial(ctx, "ws://127.0.0.1:"+strconv.Itoa(port)+"/ws", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	write := func(s string) {
		if err := c.Write(ctx, websocket.MessageText, []byte(s)); err != nil {
			t.Fatal(err)
		}
	}
	var raw []string
	read := func() protocol.ServerMsg {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read after %v: %v", raw, err)
		}
		raw = append(raw, string(data))
		msg, err := protocol.DecodeServer(data)
		if err != nil {
			t.Fatalf("invalid event %s: %v", data, err)
		}
		return msg
	}

	write(`{"type":"trace.start","target":"a.example"}`)
	if s, ok := read().(protocol.TraceStarted); !ok || s.Target != "a.example" {
		t.Fatalf("first event %v", raw)
	}
	for {
		if h, ok := read().(protocol.Hop); ok && h.TTL == 1 {
			break
		}
	}
	write(`{"type":"trace.start","target":"b.example"}`)

	var afterB []protocol.ServerMsg
	sawB := false
	for {
		msg := read()
		if s, ok := msg.(protocol.TraceStarted); ok && s.Target == "b.example" {
			sawB = true
			if s.ResolvedIP == nil || *s.ResolvedIP != ipB || s.Origin.PublicIP == nil {
				t.Errorf("trace.started for B = %+v", s)
			}
			continue
		}
		if sawB {
			afterB = append(afterB, msg)
		}
		if _, ok := msg.(protocol.TraceDone); ok && sawB {
			break
		}
	}
	for _, r := range raw {
		if strings.Contains(r, "late.a.example") {
			t.Errorf("event from the cancelled trace leaked: %s", r)
		}
	}
	var hop *protocol.Hop
	for _, m := range afterB {
		switch v := m.(type) {
		case protocol.Hop:
			hop = &v
			if v.IP == nil || *v.IP != ipB {
				t.Errorf("hop after B started is not B's: %+v", v)
			}
		case protocol.HopUpdate:
			if v["ttl"] != 1 {
				t.Errorf("unexpected update %v", v)
			}
		case protocol.TraceDone:
			if !v.Reached {
				t.Error("B should report reached")
			}
		default:
			t.Errorf("unexpected event after B started: %#v", m)
		}
	}
	if hop == nil || !hop.GeoSource.Valid() {
		t.Fatalf("B hop = %+v", hop)
	}
	joined := strings.Join(raw, "\n")
	for _, want := range []string{`"host":"be2.nyc.example.net"`, `"geoSource":"hostname"`, `"asn":64500`} {
		if !strings.Contains(joined, want) {
			t.Errorf("stream lacks %s:\n%s", want, joined)
		}
	}
}

// noReach reports every destination as unreachable without touching the network.
type noReach struct{}

func (noReach) Check(context.Context, netip.Addr) reach.Result { return reach.Result{} }
