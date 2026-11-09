package main

import (
	"context"
	"net"
	"net/http"
	"runtime"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/enrich"
	"github.com/blackpaw-studio/lightpath/internal/live"
	"github.com/blackpaw-studio/lightpath/internal/reach"
	"github.com/blackpaw-studio/lightpath/internal/server"
	"github.com/blackpaw-studio/lightpath/internal/target"
	"github.com/blackpaw-studio/lightpath/internal/trace"
)

// httpBackstop caps an ip-api call if the client's own per-request timeout
// were ever bypassed.
const httpBackstop = 15 * time.Second

// newLiveSource builds the real trace pipeline. The enrichment clients are
// shared by every trace in this process (one rate limiter, one cache), the
// origin prefetch starts now, and everything stops when ctx ends.
func newLiveSource(ctx context.Context) (server.TraceSource, server.Validator, error) {
	clock := enrich.RealClock
	resolver := net.DefaultResolver
	ipapi := enrich.NewIPAPI(enrich.IPAPIConfig{HTTP: &http.Client{Timeout: httpBackstop}, Clock: clock})
	cymru := enrich.NewCymru(resolver, clock)
	origin := enrich.NewOriginResolver(enrich.OriginConfig{Self: ipapi, ASN: cymru, Clock: clock})
	origin.Start(ctx)
	go func() {
		<-ctx.Done()
		ipapi.Close()
	}()

	src, err := live.New(live.Config{
		Runner:  trace.Runner{Exec: trace.ExecCommand},
		Command: func(tgt string) (string, []string) { return target.CommandFor(tgt, runtime.GOOS) },
		Enricher: enrich.New(enrich.Config{
			Host:   enrich.NewRDNS(resolver, clock),
			ASN:    cymru,
			Geo:    ipapi,
			Origin: origin,
		}),
		Origin:   origin,
		Reach:    reach.Checker{Dial: (&net.Dialer{}).DialContext, Clock: clock},
		Validate: target.Validate,
	})
	if err != nil {
		ipapi.Close()
		return nil, nil, err
	}
	return src, target.Validate, nil
}
