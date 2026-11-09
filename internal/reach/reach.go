// Package reach checks whether a destination accepts TCP connections. It is
// how Lightpath tells a firewalled host that drops traceroute probes from one
// that is simply further away. Connect only: nothing is ever written.
package reach

import (
	"context"
	"net"
	"net/netip"
	"strconv"
	"time"
)

// Defaults for the zero value of Checker's tunables.
const (
	DefaultTimeout  = 2 * time.Second
	DefaultAttempts = 3
)

// DefaultPorts are tried in order.
var DefaultPorts = []int{443, 80}

// DialFunc matches net.Dialer.DialContext.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Clock abstracts time so tests never sleep. enrich.RealClock satisfies it.
type Clock interface {
	Now() time.Time
	Timer(d time.Duration) (<-chan time.Time, func())
}

// Result is the outcome of a check. RTT is the fastest successful connect.
type Result struct {
	Reachable bool
	Port      int
	RTT       time.Duration
}

// Checker connects to an address on each port in turn. Dial and Clock are
// required; the other fields default as documented on the package constants.
type Checker struct {
	Dial     DialFunc
	Clock    Clock
	Ports    []int
	Timeout  time.Duration
	Attempts int
}

// Check returns the first port that accepts a connection, with the fastest of
// up to Attempts connects as its delay. The first connect on a port decides
// it; failures after a success are ignored. A cancelled ctx aborts the
// in-flight dial and yields an unreachable result.
func (c Checker) Check(ctx context.Context, ip netip.Addr) Result {
	ports := c.Ports
	if len(ports) == 0 {
		ports = DefaultPorts
	}
	for _, port := range ports {
		if ctx.Err() != nil {
			return Result{}
		}
		if rtt, ok := c.probePort(ctx, ip, port); ok {
			return Result{Reachable: true, Port: port, RTT: rtt}
		}
	}
	return Result{}
}

// probePort connects up to Attempts times and returns the fastest connect. It
// fails only if the first connect does.
func (c Checker) probePort(ctx context.Context, ip netip.Addr, port int) (time.Duration, bool) {
	attempts := c.Attempts
	if attempts <= 0 {
		attempts = DefaultAttempts
	}
	addr := net.JoinHostPort(ip.String(), strconv.Itoa(port))
	var best time.Duration
	succeeded := false
	for i := 0; i < attempts; i++ {
		rtt, err := c.connect(ctx, addr)
		if err != nil {
			if !succeeded {
				return 0, false
			}
			if ctx.Err() != nil {
				break
			}
			continue
		}
		if !succeeded || rtt < best {
			best = rtt
		}
		succeeded = true
	}
	return best, succeeded
}

func (c Checker) connect(ctx context.Context, addr string) (time.Duration, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := withTimeout(ctx, c.Clock, timeout)
	defer cancel()
	start := c.Clock.Now()
	conn, err := c.Dial(ctx, "tcp", addr)
	if err != nil {
		return 0, err
	}
	rtt := c.Clock.Now().Sub(start)
	conn.Close()
	return rtt, nil
}

// withTimeout is context.WithTimeout driven by an injected Clock.
func withTimeout(ctx context.Context, clk Clock, d time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	timer, stop := clk.Timer(d)
	go func() {
		defer stop()
		select {
		case <-timer:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}
