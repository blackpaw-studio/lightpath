package replay

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

func recordedEvents(t *testing.T) (*fakeClock, *Recorder) {
	t.Helper()
	clock := newFakeClock()
	rec := NewRecorder(clock)
	rec.Record(protocol.TraceStarted{Target: "example.com"})
	clock.Advance(ms(120))
	rec.Record(protocol.Hop{TTL: 1, GeoSource: protocol.GeoLocal})
	clock.Advance(ms(220))
	rec.Record(mustHopUpdate(t, 1, map[string]any{"asn": 15169}))
	rec.Record(protocol.TraceDone{Reached: true})
	return clock, rec
}

func TestRecorderMarshalMatchesGolden(t *testing.T) {
	_, rec := recordedEvents(t)
	got, err := rec.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/recorded.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("recorded JSON differs from golden:\n%s", got)
	}
}

func TestRecordedFixtureRoundTripsThroughLoad(t *testing.T) {
	_, rec := recordedEvents(t)
	data, err := rec.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	f, err := Load(strings.NewReader(string(data)))
	if err != nil {
		t.Fatalf("Load(recorded): %v", err)
	}
	if len(f.Events) != 4 || f.Events[2].T != ms(340) {
		t.Fatalf("round trip: %+v", f.Events)
	}
}

type stubSource func(ctx context.Context, target string, emit func(protocol.ServerMsg)) error

func (s stubSource) Trace(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
	return s(ctx, target, emit)
}

func TestRecordingSourcePassesThroughAndSavesOnFinish(t *testing.T) {
	clock := newFakeClock()
	inner := stubSource(func(_ context.Context, target string, emit func(protocol.ServerMsg)) error {
		emit(protocol.TraceStarted{Target: target})
		clock.Advance(ms(50))
		emit(protocol.TraceDone{Reached: false})
		return nil
	})
	var saved []byte
	src := &RecordingSource{Inner: inner, Clock: clock, Save: func(b []byte) error { saved = b; return nil }}
	var got []protocol.ServerMsg
	if err := src.Trace(context.Background(), "example.com", func(m protocol.ServerMsg) { got = append(got, m) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("pass-through: %d events", len(got))
	}
	f, err := Load(strings.NewReader(string(saved)))
	if err != nil || len(f.Events) != 2 || f.Events[1].T != ms(50) {
		t.Fatalf("saved fixture: %+v err=%v", f, err)
	}
}

func TestRecordingSourcePropagatesInnerAndSaveErrors(t *testing.T) {
	boom := errors.New("boom")
	clock := newFakeClock()
	src := &RecordingSource{
		Inner: stubSource(func(context.Context, string, func(protocol.ServerMsg)) error { return boom }),
		Clock: clock, Save: func([]byte) error { return nil },
	}
	if err := src.Trace(context.Background(), "x", func(protocol.ServerMsg) {}); !errors.Is(err, boom) {
		t.Fatalf("inner error: %v", err)
	}
	src = &RecordingSource{
		Inner: stubSource(func(context.Context, string, func(protocol.ServerMsg)) error { return nil }),
		Clock: clock, Save: func([]byte) error { return errors.New("disk full") },
	}
	if err := src.Trace(context.Background(), "x", func(protocol.ServerMsg) {}); err == nil {
		t.Fatal("expected save error")
	}
}

func TestConcurrentRecordingsSaveOneAtATime(t *testing.T) {
	var inFlight, overlaps, innerDone atomic.Int32
	rs := &RecordingSource{
		Inner: stubSource(func(context.Context, string, func(protocol.ServerMsg)) error {
			innerDone.Add(1)
			return nil
		}),
		Clock: newFakeClock(),
		Save: func([]byte) error {
			if inFlight.Add(1) > 1 {
				overlaps.Add(1)
			}
			// Hold the first save open until both traces have finished, then
			// yield so an unserialized second save would enter alongside it.
			for innerDone.Load() < 2 {
				runtime.Gosched()
			}
			for range 1000 {
				runtime.Gosched()
			}
			inFlight.Add(-1)
			return nil
		},
	}
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _ = rs.Trace(context.Background(), "x", func(protocol.ServerMsg) {}) }()
	}
	wg.Wait()
	if overlaps.Load() != 0 {
		t.Fatal("saves ran concurrently")
	}
}

func TestWriteFileAtomicReplacesWholeFileAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.json")
	if err := WriteFileAtomic(path, []byte("old contents that are longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "new" {
		t.Fatalf("got %q, %v", got, err)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("stray files: %v", ents)
	}
}

func TestWriteFileAtomicFailureKeepsOriginalAndCleansTemp(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "occupied")
	if err := os.Mkdir(target, 0o700); err != nil { // rename onto a directory fails
		t.Fatal(err)
	}
	if err := WriteFileAtomic(target, []byte("x"), 0o600); err == nil {
		t.Fatal("expected error")
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("temp file left behind: %v", ents)
	}
}

func mustHopUpdate(t *testing.T, ttl int, fields map[string]any) protocol.HopUpdate {
	t.Helper()
	u, err := protocol.NewHopUpdate(ttl, fields)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
