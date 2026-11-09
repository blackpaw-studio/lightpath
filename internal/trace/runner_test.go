package trace

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

type fakeCmd struct {
	out     io.Reader
	waitErr error
	waited  chan struct{}
}

func (c *fakeCmd) Output() io.Reader { return c.out }
func (c *fakeCmd) Wait() error       { close(c.waited); return c.waitErr }

type call struct {
	name string
	args []string
}

// fakeExec returns a ExecFunc that serves out, records the call, and exposes
// the Cmd so tests can check Wait ran.
func fakeExec(out io.Reader, waitErr error, calls *[]call, cmd **fakeCmd) ExecFunc {
	return func(ctx context.Context, name string, args []string) (Cmd, error) {
		if calls != nil {
			*calls = append(*calls, call{name, args})
		}
		c := &fakeCmd{out: out, waitErr: waitErr, waited: make(chan struct{})}
		if cmd != nil {
			*cmd = c
		}
		return c, nil
	}
}

func failExec(err error) ExecFunc {
	return func(context.Context, string, []string) (Cmd, error) { return nil, err }
}

func run(t *testing.T, ex ExecFunc) []Event {
	t.Helper()
	var evs []Event
	ch := Runner{Exec: ex}.Run(context.Background(), "traceroute", []string{"-n", "1.1.1.1"})
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

func last(t *testing.T, evs []Event) Event {
	t.Helper()
	if len(evs) == 0 {
		t.Fatal("no events")
	}
	return evs[len(evs)-1]
}

func TestRunnerPassesNameAndArgvThrough(t *testing.T) {
	var calls []call
	run(t, fakeExec(strings.NewReader(""), nil, &calls, nil))
	if len(calls) != 1 || calls[0].name != "traceroute" || strings.Join(calls[0].args, " ") != "-n 1.1.1.1" {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestRunnerReachedWhenLastHopIsResolvedIP(t *testing.T) {
	var cmd *fakeCmd
	evs := run(t, fakeExec(openFixture(t, "macos.reached.txt"), nil, nil, &cmd))
	if got := last(t, evs); got != (Done{Reached: true, Reason: protocol.EndReached}) {
		t.Fatalf("last = %#v", got)
	}
	if len(evs) != 1+7+1 { // header, 7 hops, done
		t.Fatalf("len(events) = %d", len(evs))
	}
	select {
	case <-cmd.waited:
	default:
		t.Fatal("Wait was not called")
	}
}

func TestRunnerReachedComparesAddressesNotStrings(t *testing.T) {
	out := "traceroute6 to h (2001:DB8::64), 64 hops max\n 1  2001:db8:0::64  1 ms  1 ms  1 ms\n"
	if got := last(t, run(t, fakeExec(strings.NewReader(out), nil, nil, nil))); got != (Done{Reached: true, Reason: protocol.EndReached}) {
		t.Fatalf("last = %#v", got)
	}
}

func TestRunnerNotReachedWhenLastHopTimesOut(t *testing.T) {
	evs := run(t, fakeExec(openFixture(t, "linux.timeouts.txt"), nil, nil, nil))
	if got := last(t, evs); got != (Done{Reached: false, Reason: protocol.EndLimit}) {
		t.Fatalf("last = %#v", got)
	}
}

func TestRunnerNonZeroExitWithHopsStillDone(t *testing.T) {
	evs := run(t, fakeExec(openFixture(t, "linux.timeouts.txt"), errors.New("exit status 1"), nil, nil))
	if _, ok := last(t, evs).(Done); !ok {
		t.Fatalf("last = %#v", last(t, evs))
	}
}

func TestRunnerMissingBinary(t *testing.T) {
	err := &exec.Error{Name: "traceroute", Err: exec.ErrNotFound}
	evs := run(t, failExec(err))
	got, ok := last(t, evs).(ErrorEvent)
	if len(evs) != 1 || !ok || got.Code != protocol.ErrTracerouteMissing {
		t.Fatalf("events = %#v", evs)
	}
}

func TestRunnerStartFailure(t *testing.T) {
	evs := run(t, failExec(errors.New("fork/exec: permission denied")))
	got, ok := last(t, evs).(ErrorEvent)
	if len(evs) != 1 || !ok || got.Code != protocol.ErrTracerouteFailed || !strings.Contains(got.Message, "permission denied") {
		t.Fatalf("events = %#v", evs)
	}
}

func TestRunnerNonZeroExitWithoutHopsFailsWithOutputTail(t *testing.T) {
	out := "traceroute: unknown host nope.invalid\n"
	evs := run(t, fakeExec(strings.NewReader(out), errors.New("exit status 68"), nil, nil))
	got, ok := last(t, evs).(ErrorEvent)
	if len(evs) != 1 || !ok || got.Code != protocol.ErrTracerouteFailed {
		t.Fatalf("events = %#v", evs)
	}
	for _, want := range []string{"exit status 68", "unknown host nope.invalid"} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("message %q lacks %q", got.Message, want)
		}
	}
}

func TestRunnerUnrecognisedOutputFails(t *testing.T) {
	evs := run(t, fakeExec(strings.NewReader("1: 10.0.0.1  0.5ms\n"), nil, nil, nil))
	got, ok := last(t, evs).(ErrorEvent)
	if !ok || got.Code != protocol.ErrTracerouteFailed || !strings.Contains(got.Message, "unrecognised") {
		t.Fatalf("events = %#v", evs)
	}
}

func TestRunnerErrorMessageTailIsBounded(t *testing.T) {
	out := strings.Repeat("x", 100_000) + "\nTAIL-MARKER\n"
	evs := run(t, fakeExec(strings.NewReader(out), errors.New("exit status 1"), nil, nil))
	got := last(t, evs).(ErrorEvent)
	if len(got.Message) > 2*tailBytes || !strings.Contains(got.Message, "TAIL-MARKER") {
		t.Fatalf("message len %d", len(got.Message))
	}
}

// Cancel: the process is killed (the fake closes its output on ctx.Done, as
// exec.CommandContext does), Wait still runs, and no Done/Error follows.
func TestRunnerCancelStopsWithoutTerminalEvent(t *testing.T) {
	pr, pw := io.Pipe()
	var cmd *fakeCmd
	ex := func(ctx context.Context, name string, args []string) (Cmd, error) {
		go func() { <-ctx.Done(); pw.CloseWithError(errors.New("killed")) }()
		cmd = &fakeCmd{out: pr, waitErr: errors.New("signal: killed"), waited: make(chan struct{})}
		return cmd, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	ch := Runner{Exec: ex}.Run(ctx, "traceroute", nil)

	go io.WriteString(pw, "traceroute to 1.1.1.1 (1.1.1.1), 30 hops max\n 1  10.0.0.1  1 ms  1 ms  1 ms\n")
	for i := 0; i < 2; i++ {
		select {
		case <-ch:
		case <-time.After(guard):
			t.Fatal("no streamed event before cancel")
		}
	}
	cancel()

	timeout := time.After(guard)
	for done := false; !done; {
		select {
		case ev, ok := <-ch:
			if !ok {
				done = true
			} else if _, isDone := ev.(Done); isDone {
				t.Fatal("Done after cancel")
			} else if _, isErr := ev.(ErrorEvent); isErr {
				t.Fatal("ErrorEvent after cancel")
			}
		case <-timeout:
			t.Fatal("runner did not stop after cancel")
		}
	}
	select {
	case <-cmd.waited:
	default:
		t.Fatal("Wait was not called after cancel")
	}
}
