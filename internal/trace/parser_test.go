package trace

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const guard = 5 * time.Second // only bounds a hung test; never waited on in a passing run

func openFixture(t *testing.T, name string) io.Reader {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// render flattens an event to one comparable line.
func render(ev Event) string {
	switch e := ev.(type) {
	case Header:
		return fmt.Sprintf("header %s %s", e.Target, e.ResolvedIP)
	case HopEvent:
		h := e.Hop
		probes := make([]string, len(h.Probes))
		for i, p := range h.Probes {
			probes[i] = "*"
			if p.RTTMs != nil {
				probes[i] = *p.IP + "@" + strconv.FormatFloat(*p.RTTMs, 'f', -1, 64)
			}
		}
		ip := "-"
		if h.IP != nil {
			ip = *h.IP
		}
		return fmt.Sprintf("hop %d %s [%s] %v", h.TTL, ip, strings.Join(probes, " "), h.Annotations)
	}
	return fmt.Sprintf("unexpected %T", ev)
}

func drain(t *testing.T, ch <-chan Event) []string {
	t.Helper()
	var out []string
	timeout := time.After(guard)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, render(ev))
		case <-timeout:
			t.Fatal("event channel never closed")
		}
	}
}

func TestParseFixtures(t *testing.T) {
	tests := []struct {
		fixture string
		want    []string
	}{
		{"macos.reached.txt", []string{
			"header 1.1.1.1 1.1.1.1",
			"hop 1 10.0.4.1 [10.0.4.1@0.756 10.0.4.1@0.309 10.0.4.1@0.318] []",
			"hop 2 96.250.220.1 [96.250.220.1@5.02 96.250.220.1@6.167 96.250.220.1@7.349] []",
			"hop 3 100.41.23.66 [100.41.23.66@3.876 100.41.23.66@2.793 100.41.23.66@3.226] []",
			"hop 4 - [* * *] []",
			"hop 5 152.193.5.194 [152.193.5.194@14.627 * *] []",
			// macOS continuation lines: one probe per IP across three lines.
			"hop 6 162.158.61.117 [162.158.61.117@5.017 162.158.61.129@5.768 162.158.61.113@6.884] []",
			"hop 7 1.1.1.1 [1.1.1.1@5.506 1.1.1.1@7.307 1.1.1.1@6.038] []",
		}},
		{"macos.hostname.txt", []string{
			"header one.one.one.one 1.1.1.1",
			"hop 1 10.0.4.1 [10.0.4.1@0.951 10.0.4.1@0.259 10.0.4.1@0.254] []",
			"hop 2 96.250.220.1 [96.250.220.1@4.144 96.250.220.1@1.227 96.250.220.1@3.624] []",
			"hop 3 100.41.23.66 [100.41.23.66@6.771 100.41.23.64@4.979 100.41.23.64@4.445] []",
		}},
		{"linux.timeouts.txt", []string{
			"header 1.1.1.1 1.1.1.1",
			"hop 1 172.17.0.1 [172.17.0.1@0.037 172.17.0.1@0.007 172.17.0.1@0.003] []",
			"hop 2 - [* * *] []",
			"hop 3 - [* * *] []",
			"hop 4 - [* * *] []",
		}},
		{"linux.multipath.synthetic.txt", []string{
			"header example.com 93.184.216.34",
			"hop 1 192.168.1.1 [192.168.1.1@0.512 192.168.1.1@0.488 192.168.1.1@0.47] []",
			"hop 2 10.1.1.1 [10.1.1.1@3.1 10.1.1.2@3.4 10.1.1.1@3] []",
			"hop 3 172.16.0.9 [* 172.16.0.9@8.2 172.16.0.9@8] []",
			"hop 4 - [* * *] []",
			"hop 5 93.184.216.34 [93.184.216.34@11.9 93.184.216.34@11.8 93.184.216.34@12] []",
		}},
		{"macos.continuation.synthetic.txt", []string{
			"header example.com 93.184.216.34",
			"hop 1 192.168.1.1 [192.168.1.1@0.5 192.168.1.1@0.4 192.168.1.1@0.4] []",
			"hop 2 10.0.0.1 [10.0.0.1@1 10.0.0.2@2 10.0.0.3@3] []",
			// EOF flushes the incomplete hop, padded to three probes.
			"hop 3 10.9.9.9 [10.9.9.9@5 * *] []",
		}},
		{"annotations.synthetic.txt", []string{
			"header 10.0.0.9 10.0.0.9",
			"hop 1 10.0.0.1 [10.0.0.1@0.5 10.0.0.1@0.4 10.0.0.1@0.4] []",
			"hop 2 10.0.0.2 [10.0.0.2@1 10.0.0.2@1.1 10.0.0.2@1] [!H]",
			"hop 3 10.0.0.3 [10.0.0.3@1 * *] [!N]",
			"hop 4 10.0.0.4 [10.0.0.4@2 10.0.0.4@2 10.0.0.4@2] [!X !<10> !P]",
			"hop 5 10.0.0.5 [10.0.0.5@3 10.0.0.5@3 10.0.0.5@3] [!S !A !F]",
		}},
		{"garbage.synthetic.txt", []string{
			"header example.com 93.184.216.34",
			"hop 1 192.168.1.1 [192.168.1.1@0.5 192.168.1.1@0.4 192.168.1.1@0.4] []",
			"hop 3 10.0.0.3 [10.0.0.3@1 10.0.0.3@1.1 10.0.0.3@1.2] []",
		}},
		{"macos.v6.synthetic.txt", []string{
			"header ipv6.example.com 2001:db8::64",
			"hop 1 fe80::1 [fe80::1@1.2 fe80::1@0.9 fe80::1@0.8] []",
			"hop 2 2001:db8::1 [2001:db8::1@4 2001:db8::1@4.1 2001:db8::1@4.2] []",
			"hop 3 2001:db8::64 [2001:db8::64@9 2001:db8::64@9.1 2001:db8::64@9.2] []",
		}},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			got := drain(t, Parse(openFixture(t, tc.fixture)))
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Errorf("events mismatch\n got:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(tc.want, "\n"))
			}
		})
	}
}

func TestParseHopsAlwaysHaveNonNilSlices(t *testing.T) {
	for ev := range Parse(strings.NewReader(" 1  10.0.0.1  1 ms  1 ms  1 ms\n")) {
		h := ev.(HopEvent).Hop
		if h.Annotations == nil || len(h.Probes) != 3 {
			t.Fatalf("annotations=%v probes=%d", h.Annotations, len(h.Probes))
		}
	}
}

// A hop must reach the consumer as soon as its line is written, before the
// next line exists. This is the ~1 s latency contract.
func TestParseStreamsHopBeforeNextLine(t *testing.T) {
	pr, pw := io.Pipe()
	ch := Parse(pr)
	recv := func() Event {
		select {
		case ev := <-ch:
			return ev
		case <-time.After(guard):
			t.Fatal("event did not arrive before the next line was written")
			return nil
		}
	}
	write := func(s string) {
		if _, err := io.WriteString(pw, s); err != nil {
			t.Fatal(err)
		}
	}

	write("traceroute to 1.1.1.1 (1.1.1.1), 30 hops max, 40 byte packets\n")
	if got := render(recv()); got != "header 1.1.1.1 1.1.1.1" {
		t.Fatal(got)
	}
	write(" 1  10.0.0.1  1.5 ms  1.6 ms  1.7 ms\n")
	if got := render(recv()); !strings.HasPrefix(got, "hop 1 10.0.0.1") {
		t.Fatal(got)
	}
	// Hop 2 is split across lines: only the third probe completes it.
	write(" 2  10.0.0.2  2 ms\n")
	write("    10.0.0.3  3 ms  4 ms\n")
	if got := render(recv()); got != "hop 2 10.0.0.2 [10.0.0.2@2 10.0.0.3@3 10.0.0.3@4] []" {
		t.Fatal(got)
	}
	pw.Close()
	if _, ok := <-ch; ok {
		t.Fatal("channel should close at EOF")
	}
}

func TestParseContextStopsWhenConsumerLeaves(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := ParseContext(ctx, strings.NewReader(" 1  10.0.0.1  1 ms  1 ms  1 ms\n 2  10.0.0.2  1 ms  1 ms  1 ms\n"))
	<-ch
	cancel()
	timeout := time.After(guard)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("parser goroutine did not stop after cancel")
		}
	}
}
