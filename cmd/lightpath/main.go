// Command lightpath is the local Lightpath agent: it serves the web UI and a
// WebSocket that streams traceroute hops, bound to loopback only.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/browser"
	"github.com/blackpaw-studio/lightpath/internal/replay"
	"github.com/blackpaw-studio/lightpath/internal/server"
	"github.com/blackpaw-studio/lightpath/ui"
)

// version is set by GoReleaser via -ldflags "-X main.version=...".
var version = "dev"

const (
	defaultPort       = 47800
	loopbackHost      = "127.0.0.1"
	readHeaderTimeout = 5 * time.Second
	shutdownTimeout   = 3 * time.Second
	traceStopTimeout  = 10 * time.Second // cap on waiting for traces to return at shutdown
)

// errLiveNotWired is returned until the real runner and enricher are wired in.
var errLiveNotWired = errors.New("live tracing is not wired yet; use --replay <file>")

// deps holds everything run touches outside the process, so tests can inject fakes.
type deps struct {
	stderr      io.Writer
	listen      func(network, addr string) (net.Listener, error)
	openBrowser func(url string) error
	clock       replay.Clock
	static      fs.FS
	live        func() (server.TraceSource, server.Validator, error)
	writeFile   func(path string, data []byte) error
}

func defaultDeps() deps {
	dist, err := fs.Sub(ui.Dist, "dist")
	if err != nil {
		dist = nil // placeholder page
	}
	return deps{
		stderr:      os.Stderr,
		listen:      net.Listen,
		openBrowser: browser.Open,
		clock:       replay.SystemClock,
		static:      dist,
		live: func() (server.TraceSource, server.Validator, error) {
			return nil, nil, errLiveNotWired
		},
		writeFile: func(path string, data []byte) error { return replay.WriteFileAtomic(path, data, 0o600) },
	}
}

type options struct {
	port   int
	replay string
	record string
	noOpen bool
}

func parseFlags(args []string, errOut io.Writer) (options, error) {
	var o options
	fset := flag.NewFlagSet("lightpath", flag.ContinueOnError)
	fset.SetOutput(errOut)
	fset.IntVar(&o.port, "port", defaultPort, "TCP port to listen on (127.0.0.1 only)")
	fset.StringVar(&o.replay, "replay", "", "replay a recorded event stream instead of running traceroute")
	fset.StringVar(&o.record, "record", "", "write each trace's event stream to this file")
	fset.BoolVar(&o.noOpen, "no-open", false, "do not open a browser")
	if err := fset.Parse(args); err != nil {
		return options{}, err
	}
	if fset.NArg() > 0 {
		return options{}, fmt.Errorf("unexpected arguments: %v", fset.Args())
	}
	if o.port < 0 || o.port > 65535 {
		return options{}, fmt.Errorf("invalid --port %d", o.port)
	}
	return o, nil
}

type app struct {
	ln      net.Listener
	handler *server.Server
}

// source builds the trace source and target validator for the chosen mode.
func source(o options, d deps) (server.TraceSource, server.Validator, error) {
	var (
		src server.TraceSource
		val server.Validator
	)
	if o.replay != "" {
		f, err := replay.LoadFile(o.replay)
		if err != nil {
			return nil, nil, err
		}
		src = replay.NewPlayer(f, d.clock)
		val = func(string) error { return nil } // the target is ignored in replay mode
	} else {
		var err error
		if src, val, err = d.live(); err != nil {
			return nil, nil, err
		}
	}
	if o.record != "" {
		src = &replay.RecordingSource{
			Inner: src,
			Clock: d.clock,
			Save:  func(data []byte) error { return d.writeFile(o.record, data) },
		}
	}
	return src, val, nil
}

func listenLoopback(d deps, port int) (net.Listener, error) {
	ln, err := d.listen("tcp", net.JoinHostPort(loopbackHost, strconv.Itoa(port)))
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			return nil, fmt.Errorf("port %d is in use; pick another with --port: %w", port, err)
		}
		return nil, fmt.Errorf("listen on %s:%d: %w", loopbackHost, port, err)
	}
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !addr.IP.IsLoopback() {
		ln.Close()
		return nil, fmt.Errorf("refusing to serve on non-loopback address %v", ln.Addr())
	}
	return ln, nil
}

// start validates inputs, binds loopback, builds the handler and opens the browser.
func start(ctx context.Context, o options, d deps) (*app, error) {
	src, val, err := source(o, d)
	if err != nil {
		return nil, err
	}
	ln, err := listenLoopback(d, o.port)
	if err != nil {
		return nil, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	h, err := server.New(server.Config{Port: port, Static: d.static, Source: src, Validate: val, Context: ctx})
	if err != nil {
		ln.Close()
		return nil, err
	}
	url := "http://" + net.JoinHostPort(loopbackHost, strconv.Itoa(port)) + "/"
	fmt.Fprintf(d.stderr, "lightpath %s listening on %s\n", version, url)
	if !o.noOpen {
		if err := d.openBrowser(url); err != nil {
			fmt.Fprintf(d.stderr, "could not open a browser (%v); open %s manually\n", err, url)
		}
	}
	return &app{ln: ln, handler: h}, nil
}

// serve blocks until ctx is cancelled, then shuts down gracefully.
func (a *app) serve(ctx context.Context) error {
	srv := &http.Server{Handler: a.handler, ReadHeaderTimeout: readHeaderTimeout}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(a.ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	// Hijacked WebSockets are invisible to Shutdown; their sessions end with
	// ctx, and every trace child must be gone before we exit.
	tctx, tcancel := context.WithTimeout(context.WithoutCancel(ctx), traceStopTimeout)
	defer tcancel()
	if err := a.handler.Wait(tctx); err != nil {
		return fmt.Errorf("waiting for traces to stop: %w", err)
	}
	return nil
}

func run(ctx context.Context, args []string, d deps) error {
	o, err := parseFlags(args, d.stderr)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	a, err := start(ctx, o, d)
	if err != nil {
		return err
	}
	return a.serve(ctx)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], defaultDeps()); err != nil {
		fmt.Fprintln(os.Stderr, "lightpath:", err)
		stop()
		os.Exit(1)
	}
}
