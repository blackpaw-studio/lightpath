package replay

import (
	"strings"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

func TestLoadFileParsesTinyFixture(t *testing.T) {
	f, err := LoadFile("testdata/tiny.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Events) != 6 {
		t.Fatalf("events: %d", len(f.Events))
	}
	if _, ok := f.Events[0].Msg.(protocol.TraceStarted); !ok {
		t.Fatalf("first event: %#v", f.Events[0].Msg)
	}
	if f.Events[1].T != 40*time.Millisecond {
		t.Fatalf("offset: %v", f.Events[1].T)
	}
	if _, ok := f.Events[4].Msg.(protocol.HopUpdate); !ok {
		t.Fatalf("update event: %#v", f.Events[4].Msg)
	}
}

func TestLoadRejectsBadFixtures(t *testing.T) {
	ev := `{"t":0,"event":{"type":"trace.done","reached":true}}`
	for name, doc := range map[string]string{
		"not json":            `nope`,
		"unsupported version": `{"version":2,"events":[` + ev + `]}`,
		"missing version":     `{"events":[` + ev + `]}`,
		"no events":           `{"version":1,"events":[]}`,
		"bad event":           `{"version":1,"events":[{"t":0,"event":{"type":"banana"}}]}`,
		"client message":      `{"version":1,"events":[{"t":0,"event":{"type":"trace.cancel"}}]}`,
		"negative offset":     `{"version":1,"events":[{"t":-1,"event":{"type":"trace.done","reached":true}}]}`,
		"decreasing offsets":  `{"version":1,"events":[{"t":50,"event":{"type":"trace.done","reached":true}},` + ev + `]}`,
		"unknown field":       `{"version":1,"extra":1,"events":[` + ev + `]}`,
	} {
		if _, err := Load(strings.NewReader(doc)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestLoadFileMissingFile(t *testing.T) {
	if _, err := LoadFile("testdata/does-not-exist.json"); err == nil {
		t.Fatal("expected error")
	}
}
