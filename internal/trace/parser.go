// Package trace runs traceroute and turns its text output into a stream of
// typed events. Parse handles macOS/BSD and Butskoy (Linux) formats produced
// by `traceroute -n -q 3`.
package trace

import (
	"bufio"
	"context"
	"io"
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// probesPerHop matches the `-q 3` the agent always passes.
const probesPerHop = 3

const (
	maxTTL        = 255
	maxLineBytes  = 1 << 20
	initLineBytes = 4096
)

// Event is something the parser or runner reports: Header, HopEvent, Done or
// ErrorEvent.
type Event interface{ traceEvent() }

// Header is the "traceroute to X (IP)" line.
type Header struct {
	Target     string
	ResolvedIP string
}

// HopEvent carries one complete hop. Only ttl, probes, ip and annotations are
// set; enrichment fills in the rest.
type HopEvent struct{ Hop protocol.Hop }

func (Header) traceEvent()   {}
func (HopEvent) traceEvent() {}

var headerRe = regexp.MustCompile(`^traceroute6? to (\S+) \(([^)]+)\)`)

// Parse reads traceroute output (stdout and stderr merged) and emits a Header
// and one HopEvent per TTL as soon as the hop's three probes are known. The
// channel closes at EOF. Unrecognised lines are skipped. The caller must read
// the channel to completion; use ParseContext to be able to abandon it.
func Parse(r io.Reader) <-chan Event { return ParseContext(context.Background(), r) }

// ParseContext is Parse, but the goroutine also stops once ctx is done and
// the consumer has stopped receiving. It still blocks on reads from r, so the
// source must end (the runner's process is killed on cancel).
func ParseContext(ctx context.Context, r io.Reader) <-chan Event {
	out := make(chan Event)
	go func() {
		defer close(out)
		send := func(ev Event) bool {
			select {
			case out <- ev:
				return true
			case <-ctx.Done():
				return false
			}
		}
		var p lineParser
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, initLineBytes), maxLineBytes)
		for sc.Scan() {
			for _, ev := range p.feed(sc.Text()) {
				if !send(ev) {
					return
				}
			}
		}
		if ev, ok := p.flush(); ok {
			send(ev)
		}
	}()
	return out
}

// pendingHop accumulates probes across macOS-style continuation lines.
type pendingHop struct {
	ttl    int
	probes []protocol.Probe
	annots []string
}

type lineParser struct {
	pending *pendingHop
}

// feed consumes one line and returns the events it completes.
func (p *lineParser) feed(line string) []Event {
	if m := headerRe.FindStringSubmatch(line); m != nil {
		return append(p.flushed(), Header{Target: m[1], ResolvedIP: m[2]})
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return nil
	}
	if ttl, err := strconv.Atoi(fields[0]); err == nil {
		return p.startHop(ttl, fields[1:])
	}
	if _, ok := parseAddr(fields[0]); ok && p.pending != nil {
		return p.extend(fields)
	}
	return nil
}

func (p *lineParser) startHop(ttl int, fields []string) []Event {
	if ttl < 1 || ttl > maxTTL {
		return nil
	}
	probes, annots := scanProbes(fields)
	if len(probes) == 0 {
		return nil
	}
	evs := p.flushed()
	p.pending = &pendingHop{ttl: ttl, probes: probes, annots: annots}
	return append(evs, p.completed()...)
}

func (p *lineParser) extend(fields []string) []Event {
	probes, annots := scanProbes(fields)
	p.pending = &pendingHop{
		ttl:    p.pending.ttl,
		probes: append(p.pending.probes, probes...),
		annots: mergeAnnots(p.pending.annots, annots),
	}
	return p.completed()
}

// completed emits the pending hop once it has all its probes.
func (p *lineParser) completed() []Event {
	if p.pending == nil || len(p.pending.probes) < probesPerHop {
		return nil
	}
	return p.flushed()
}

func (p *lineParser) flushed() []Event {
	if ev, ok := p.flush(); ok {
		return []Event{ev}
	}
	return nil
}

// flush emits the pending hop, padded with timeouts to probesPerHop.
func (p *lineParser) flush() (Event, bool) {
	h := p.pending
	if h == nil {
		return nil, false
	}
	p.pending = nil
	probes := make([]protocol.Probe, probesPerHop)
	copy(probes, h.probes)
	hop := protocol.Hop{TTL: h.ttl, Probes: probes, Annotations: append([]string{}, h.annots...)}
	for _, pr := range probes {
		if pr.IP != nil {
			ip := *pr.IP
			hop.IP = &ip
			break
		}
	}
	return HopEvent{Hop: hop}, true
}

// scanProbes reads the probe tokens of one line. An address applies to the
// RTTs that follow it until the next address; `*` is a timeout; `!X` tokens
// annotate the hop.
func scanProbes(fields []string) ([]protocol.Probe, []string) {
	var (
		probes []protocol.Probe
		annots []string
		cur    *string
	)
	for i := 0; i < len(fields); i++ {
		tok := fields[i]
		if tok == "*" {
			probes = append(probes, protocol.Probe{})
			continue
		}
		if isAnnotation(tok) {
			annots = mergeAnnots(annots, []string{tok})
			continue
		}
		if addr, ok := parseAddr(tok); ok {
			s := addr.String()
			cur = &s
			continue
		}
		if i+1 < len(fields) && fields[i+1] == "ms" {
			if rtt, err := strconv.ParseFloat(tok, 64); err == nil {
				probes = append(probes, protocol.Probe{IP: cur, RTTMs: &rtt})
				i++
			}
		}
	}
	if len(probes) > probesPerHop {
		probes = probes[:probesPerHop]
	}
	return probes, annots
}

// parseAddr parses an IP token, tolerating parentheses and dropping any zone.
func parseAddr(tok string) (netip.Addr, bool) {
	addr, err := netip.ParseAddr(strings.Trim(tok, "()"))
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.WithZone(""), true
}

var annotationRe = regexp.MustCompile(`^![A-Za-z0-9<>]+$`)

func isAnnotation(tok string) bool { return annotationRe.MatchString(tok) }

// mergeAnnots appends the annotations in add that are not already in base.
func mergeAnnots(base, add []string) []string {
	out := append([]string{}, base...)
	for _, a := range add {
		if !contains(out, a) {
			out = append(out, a)
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
