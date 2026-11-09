package replay

import (
	"path/filepath"
	"testing"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// Every fixture the browser suite replays must load, old ones included: the
// replay container stays at version 1 across protocol changes.
func TestEveryE2EFixtureLoads(t *testing.T) {
	paths, err := filepath.Glob("../../ui/e2e/fixtures/*.json")
	if err != nil || len(paths) < 5 {
		t.Fatalf("fixtures = %v, %v", paths, err)
	}
	for _, p := range paths {
		t.Run(filepath.Base(p), func(t *testing.T) {
			f, err := LoadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := f.Events[0].Msg.(protocol.TraceStarted); !ok {
				t.Errorf("first event = %#v", f.Events[0].Msg)
			}
		})
	}
}

func lastDone(t *testing.T, path string) protocol.TraceDone {
	t.Helper()
	f, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	done, ok := f.Events[len(f.Events)-1].Msg.(protocol.TraceDone)
	if !ok {
		t.Fatalf("last event = %#v", f.Events[len(f.Events)-1].Msg)
	}
	return done
}

func TestQuietFixturesEndQuietWithTheirDestination(t *testing.T) {
	fw := lastDone(t, "../../ui/e2e/fixtures/quiet-firewalled.json")
	if fw.Reason == nil || *fw.Reason != protocol.EndQuiet || fw.Destination == nil || fw.Destination.Reachable {
		t.Errorf("firewalled done = %#v", fw)
	}
	qr := lastDone(t, "../../ui/e2e/fixtures/quiet-reachable.json")
	if qr.Reason == nil || *qr.Reason != protocol.EndQuiet || qr.Destination == nil || !qr.Destination.Reachable || qr.Destination.Lat == nil {
		t.Errorf("reachable done = %#v", qr)
	}
}
