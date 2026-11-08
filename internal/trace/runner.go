package trace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/netip"
	"os"
	"os/exec"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

const (
	// killWaitDelay bounds how long Wait lingers after a kill for the
	// process's output to drain.
	killWaitDelay = 2 * time.Second
	// tailBytes of raw output are kept to explain a failure.
	tailBytes = 512
)

// Done reports that traceroute finished. Reached is true when the last hop is
// the resolved target.
type Done struct{ Reached bool }

// ErrorEvent reports a failed trace using the protocol's error codes.
type ErrorEvent struct {
	Code    protocol.ErrorCode
	Message string
}

func (Done) traceEvent()       {}
func (ErrorEvent) traceEvent() {}

// Cmd is a started traceroute process.
type Cmd interface {
	// Output yields stdout and stderr merged. It reaches EOF when the
	// process exits.
	Output() io.Reader
	// Wait reaps the process and returns its exit status. It must be called
	// exactly once, after Output has been read to EOF.
	Wait() error
}

// ExecFunc starts name with argv args. The process must be killed when ctx is
// done. A missing binary must yield an error matching exec.ErrNotFound.
type ExecFunc func(ctx context.Context, name string, args []string) (Cmd, error)

// Runner runs traceroute and streams its events. The zero value uses
// ExecCommand.
type Runner struct {
	Exec ExecFunc
}

// Run starts name with args (an argv list, never a shell line) and returns a
// channel of Header, HopEvent and then exactly one of Done or ErrorEvent. If
// ctx is cancelled the process is killed and the channel closes without a
// terminal event. The caller must read the channel until it closes or cancel
// ctx.
func (r Runner) Run(ctx context.Context, name string, args []string) <-chan Event {
	out := make(chan Event)
	go func() {
		defer close(out)
		r.run(ctx, name, args, out)
	}()
	return out
}

func (r Runner) run(ctx context.Context, name string, args []string, out chan<- Event) {
	start := r.Exec
	if start == nil {
		start = ExecCommand
	}
	cmd, err := start(ctx, name, args)
	if err != nil {
		sendEvent(ctx, out, startError(name, err))
		return
	}

	tail := &tailBuffer{}
	parsed := ParseContext(ctx, io.TeeReader(cmd.Output(), tail))
	var (
		header  *Header
		lastHop *protocol.Hop
		hops    int
	)
	for ev := range parsed {
		switch e := ev.(type) {
		case Header:
			header = &e
		case HopEvent:
			hop := e.Hop
			lastHop = &hop
			hops++
		}
		if !sendEvent(ctx, out, ev) {
			break
		}
	}
	for range parsed { // join the parser goroutine
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return
	}
	sendEvent(ctx, out, finish(header, lastHop, hops, waitErr, tail.String()))
}

func sendEvent(ctx context.Context, out chan<- Event, ev Event) bool {
	select {
	case out <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}

func startError(name string, err error) ErrorEvent {
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return ErrorEvent{Code: protocol.ErrTracerouteMissing, Message: fmt.Sprintf("%s not found; install traceroute", name)}
	}
	return ErrorEvent{Code: protocol.ErrTracerouteFailed, Message: fmt.Sprintf("could not start %s: %v", name, err)}
}

// finish decides the terminal event. Non-zero exit with hops is still a
// completed trace; without hops it is a failure.
func finish(header *Header, lastHop *protocol.Hop, hops int, waitErr error, tail string) Event {
	if hops > 0 {
		return Done{Reached: reached(header, lastHop)}
	}
	msg := "traceroute produced no hops (unrecognised output format)"
	if waitErr != nil {
		msg = fmt.Sprintf("traceroute failed: %v", waitErr)
	}
	if tail != "" {
		msg += ": " + tail
	}
	return ErrorEvent{Code: protocol.ErrTracerouteFailed, Message: msg}
}

func reached(header *Header, lastHop *protocol.Hop) bool {
	if header == nil || lastHop == nil || lastHop.IP == nil {
		return false
	}
	want, err1 := netip.ParseAddr(header.ResolvedIP)
	got, err2 := netip.ParseAddr(*lastHop.IP)
	return err1 == nil && err2 == nil && want.WithZone("") == got.WithZone("")
}

// tailBuffer keeps the last tailBytes bytes written to it.
type tailBuffer struct{ buf []byte }

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > tailBytes {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-tailBytes:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return string(bytes.TrimSpace(t.buf)) }

// ExecCommand is the production ExecFunc. stdout and stderr share one OS pipe,
// so the child's writes interleave in order and the reader sees EOF when the
// process exits. There is no pty: a pipe flushes per hop on macOS and Linux.
func ExecCommand(ctx context.Context, name string, args []string) (Cmd, error) {
	c := exec.CommandContext(ctx, name, args...)
	c.WaitDelay = killWaitDelay
	c.Cancel = func() error { return c.Process.Kill() }
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("pipe: %w", err)
	}
	c.Stdout, c.Stderr = pw, pw
	err = c.Start()
	pw.Close() // the child holds its own copy
	if err != nil {
		pr.Close()
		return nil, err
	}
	return &osCmd{cmd: c, out: pr}, nil
}

type osCmd struct {
	cmd *exec.Cmd
	out *os.File
}

func (c *osCmd) Output() io.Reader { return c.out }

func (c *osCmd) Wait() error {
	defer c.out.Close()
	return c.cmd.Wait()
}
