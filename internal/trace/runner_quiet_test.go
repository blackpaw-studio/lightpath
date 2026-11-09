package trace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// blockingReader serves script, then blocks until ctx is done and returns
// EOF: a traceroute that has more to say but is still running.
type blockingReader struct {
	r   io.Reader
	ctx context.Context
}

func (b *blockingReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err == io.EOF {
		<-b.ctx.Done()
	}
	return n, err
}

// stoppable runs a script through the runner and records the exec context so
// tests can see whether the process was killed. waitGate, when non-nil,
// holds Wait until closed.
type stoppable struct {
	script   string
	execCtx  chan context.Context
	waitGate chan struct{}
}

func newStoppable(script string) *stoppable {
	return &stoppable{script: script, execCtx: make(chan context.Context, 1)}
}

func (s *stoppable) exec(ctx context.Context, _ string, _ []string) (Cmd, error) {
	s.execCtx <- ctx
	c := &fakeCmd{
		out:     &blockingReader{r: strings.NewReader(s.script), ctx: ctx},
		waitErr: errors.New("signal: killed"),
		waited:  make(chan struct{}),
	}
	if s.waitGate == nil {
		return c, nil
	}
	return &gatedCmd{fakeCmd: c, gate: s.waitGate}, nil
}

type gatedCmd struct {
	*fakeCmd
	gate chan struct{}
}

func (c *gatedCmd) Wait() error { <-c.gate; return c.fakeCmd.Wait() }

func collect(t *testing.T, ch <-chan Event) []Event {
	t.Helper()
	var evs []Event
	timeout := time.After(guard)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return evs
			}
			evs = append(evs, ev)
		case <-timeout:
			t.Fatal("runner channel never closed")
		}
	}
}

func hopCount(evs []Event) int {
	n := 0
	for _, ev := range evs {
		if _, ok := ev.(HopEvent); ok {
			n++
		}
	}
	return n
}

func fixtureText(t *testing.T, name string) string {
	t.Helper()
	b, err := io.ReadAll(openFixture(t, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRunnerStopsAfterFiveQuietHopsFollowingAReply(t *testing.T) {
	s := newStoppable(fixtureText(t, "quiet.firewalled.synthetic.txt"))
	evs := collect(t, Runner{Exec: s.exec}.Run(context.Background(), "traceroute", nil))

	// 2 replies + 5 quiet hops forwarded; the 8th (pending) hop never is.
	if got := hopCount(evs); got != 7 {
		t.Fatalf("hop events = %d, want 7", got)
	}
	if got := last(t, evs); got != (Done{Reached: false, Reason: protocol.EndQuiet}) {
		t.Fatalf("last = %#v", got)
	}
	if (<-s.execCtx).Err() == nil {
		t.Error("the traceroute process was not cancelled")
	}
}

const reply = " 1  10.0.0.1  1 ms  1 ms  1 ms\n"

func quietLines(from, n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "%2d  * * *\n", from+i)
	}
	return b.String()
}

func TestRunnerQuietHopsBeforeTheFirstReplyDoNotCount(t *testing.T) {
	// 6 silent hops, then a reply, then the trace ends on its own.
	script := "traceroute to 1.1.1.1 (1.1.1.1), 30 hops max\n" + quietLines(1, 6) + " 7  10.0.0.1  1 ms  1 ms  1 ms\n"
	evs := collect(t, Runner{Exec: fakeExec(strings.NewReader(script), nil, nil, nil)}.Run(context.Background(), "traceroute", nil))
	if got := last(t, evs); got != (Done{Reached: false, Reason: protocol.EndLimit}) {
		t.Fatalf("last = %#v", got)
	}
	if hopCount(evs) != 7 {
		t.Fatalf("hop events = %d, want 7", hopCount(evs))
	}
}

func TestRunnerAnyReplyResetsTheQuietCount(t *testing.T) {
	// reply, 4 quiet, reply, 4 quiet: never 5 in a row.
	script := "traceroute to 1.1.1.1 (1.1.1.1), 30 hops max\n" + reply +
		quietLines(2, 4) + " 6  10.0.0.2  1 ms  1 ms  1 ms\n" + quietLines(7, 4)
	evs := collect(t, Runner{Exec: fakeExec(strings.NewReader(script), nil, nil, nil)}.Run(context.Background(), "traceroute", nil))
	if got := last(t, evs); got != (Done{Reached: false, Reason: protocol.EndLimit}) {
		t.Fatalf("last = %#v", got)
	}
	if hopCount(evs) != 10 {
		t.Fatalf("hop events = %d, want 10", hopCount(evs))
	}
}

func TestRunnerCancelDuringEarlyStopSendsNoTerminalEvent(t *testing.T) {
	s := newStoppable(fixtureText(t, "quiet.firewalled.synthetic.txt"))
	s.waitGate = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := Runner{Exec: s.exec}.Run(ctx, "traceroute", nil)

	for i := 0; i < 1+7; i++ { // header + the 7 forwarded hops
		select {
		case <-ch:
		case <-time.After(guard):
			t.Fatal("missing streamed event")
		}
	}
	procCtx := <-s.execCtx
	select {
	case <-procCtx.Done():
	case <-time.After(guard):
		t.Fatal("early stop never cancelled the process")
	}
	cancel() // the user cancels while the stop is still in flight
	close(s.waitGate)

	for _, ev := range collect(t, ch) {
		t.Fatalf("event after cancel: %#v", ev)
	}
}

func TestRunnerTrailingQuietHopsBelowTheLimitStayLimit(t *testing.T) {
	evs := run(t, fakeExec(openFixture(t, "linux.timeouts.txt"), nil, nil, nil))
	if got := last(t, evs); got != (Done{Reached: false, Reason: protocol.EndLimit}) {
		t.Fatalf("last = %#v", got)
	}
}
