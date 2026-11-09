package reach

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"testing"
	"time"
)

const guard = 5 * time.Second // bounds a hung test only

var target = netip.MustParseAddr("198.51.100.7")

// fakeClock is a manually advanced clock. Timer hands each registered timer
// to the test so it can fire them.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers chan timer
}

type timer struct {
	d    time.Duration
	fire chan time.Time
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Unix(1_700_000_000, 0), timers: make(chan timer, 16)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func (c *fakeClock) Timer(d time.Duration) (<-chan time.Time, func()) {
	t := timer{d: d, fire: make(chan time.Time, 1)}
	c.timers <- t
	return t.fire, func() {}
}

// recordingConn counts writes and closes.
type recordingConn struct {
	net.Conn
	mu            sync.Mutex
	writes, close int
}

func (c *recordingConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	c.writes++
	c.mu.Unlock()
	return len(p), nil
}

func (c *recordingConn) Close() error {
	c.mu.Lock()
	c.close++
	c.mu.Unlock()
	return nil
}

func TestReachableOn443ReportsTheFastestOfThreeConnects(t *testing.T) {
	clk := newClock()
	delays := []time.Duration{30 * time.Millisecond, 18 * time.Millisecond, 25 * time.Millisecond}
	var calls []string
	dial := func(_ context.Context, _, addr string) (net.Conn, error) {
		calls = append(calls, addr)
		clk.Advance(delays[len(calls)-1])
		return &recordingConn{}, nil
	}
	got := Checker{Dial: dial, Clock: clk}.Check(context.Background(), target)
	if got != (Result{Reachable: true, Port: 443, RTT: 18 * time.Millisecond}) {
		t.Fatalf("result = %+v", got)
	}
	if len(calls) != 3 || calls[0] != "198.51.100.7:443" {
		t.Fatalf("dials = %v", calls)
	}
}

func TestRealLoopbackListenerIsReachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	var d net.Dialer
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if _, p, _ := net.SplitHostPort(addr); p == "443" {
			addr = net.JoinHostPort("127.0.0.1", port)
		}
		return d.DialContext(ctx, network, addr)
	}
	got := Checker{Dial: dial, Clock: newClock()}.Check(context.Background(), target)
	if !got.Reachable || got.Port != 443 {
		t.Fatalf("result = %+v", got)
	}
}

func TestFallsBackToPort80WhenTheFirstPortIsRefused(t *testing.T) {
	var ports []string
	dial := func(_ context.Context, _, addr string) (net.Conn, error) {
		_, p, _ := net.SplitHostPort(addr)
		ports = append(ports, p)
		if p == "443" {
			return nil, errors.New("connection refused")
		}
		return &recordingConn{}, nil
	}
	got := Checker{Dial: dial, Clock: newClock()}.Check(context.Background(), target)
	if !got.Reachable || got.Port != 80 {
		t.Fatalf("result = %+v", got)
	}
	if len(ports) != 1+3 { // one refused on 443, then three on 80
		t.Fatalf("dials = %v", ports)
	}
}

func TestUnreachableWhenBothPortsRefuse(t *testing.T) {
	n := 0
	dial := func(context.Context, string, string) (net.Conn, error) { n++; return nil, errors.New("refused") }
	got := Checker{Dial: dial, Clock: newClock()}.Check(context.Background(), target)
	if got != (Result{}) {
		t.Fatalf("result = %+v", got)
	}
	if n != 2 {
		t.Fatalf("dials = %d, want one per port", n)
	}
}

func TestLaterFailuresAfterTheFirstSuccessAreIgnored(t *testing.T) {
	clk := newClock()
	n := 0
	dial := func(context.Context, string, string) (net.Conn, error) {
		n++
		if n == 2 {
			return nil, errors.New("reset")
		}
		clk.Advance(time.Duration(n) * 10 * time.Millisecond)
		return &recordingConn{}, nil
	}
	got := Checker{Dial: dial, Clock: clk}.Check(context.Background(), target)
	if got != (Result{Reachable: true, Port: 443, RTT: 10 * time.Millisecond}) {
		t.Fatalf("result = %+v", got)
	}
}

func TestEachHangingDialTimesOutOnTheInjectedClock(t *testing.T) {
	clk := newClock()
	var timeouts []time.Duration
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	res := make(chan Result, 1)
	go func() { res <- Checker{Dial: dial, Clock: clk}.Check(context.Background(), target) }()
	for i := 0; i < 2; i++ { // 443, then 80
		select {
		case tm := <-clk.timers:
			timeouts = append(timeouts, tm.d)
			tm.fire <- time.Time{}
		case <-time.After(guard):
			t.Fatal("no timeout timer registered")
		}
	}
	select {
	case got := <-res:
		if got != (Result{}) {
			t.Fatalf("result = %+v", got)
		}
	case <-time.After(guard):
		t.Fatal("Check never returned")
	}
	if len(timeouts) != 2 || timeouts[0] != 2*time.Second || timeouts[1] != 2*time.Second {
		t.Fatalf("timeouts = %v", timeouts)
	}
}

func TestCancelAbortsTheInFlightDial(t *testing.T) {
	started := make(chan struct{})
	dialExited := make(chan struct{})
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		defer close(dialExited)
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	res := make(chan Result, 1)
	go func() { res <- Checker{Dial: dial, Clock: newClock()}.Check(ctx, target) }()
	<-started
	cancel()
	select {
	case got := <-res:
		if got.Reachable {
			t.Fatalf("result = %+v", got)
		}
	case <-time.After(guard):
		t.Fatal("Check did not return after cancel")
	}
	select {
	case <-dialExited:
	default:
		t.Fatal("dial still running after Check returned")
	}
}

func TestConnectionsAreClosedAndNeverWrittenTo(t *testing.T) {
	var conns []*recordingConn
	dial := func(context.Context, string, string) (net.Conn, error) {
		c := &recordingConn{}
		conns = append(conns, c)
		return c, nil
	}
	Checker{Dial: dial, Clock: newClock()}.Check(context.Background(), target)
	if len(conns) != 3 {
		t.Fatalf("conns = %d", len(conns))
	}
	for i, c := range conns {
		if c.close != 1 || c.writes != 0 {
			t.Errorf("conn %d: closes=%d writes=%d", i, c.close, c.writes)
		}
	}
}

func TestIPv6AddressIsBracketed(t *testing.T) {
	var addr string
	dial := func(_ context.Context, _, a string) (net.Conn, error) {
		addr = a
		return nil, errors.New("no")
	}
	Checker{Dial: dial, Clock: newClock(), Ports: []int{443}}.Check(context.Background(), netip.MustParseAddr("2001:db8::1"))
	if want := "[2001:db8::1]:" + strconv.Itoa(443); addr != want {
		t.Fatalf("addr = %q, want %q", addr, want)
	}
}
