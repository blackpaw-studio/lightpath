package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func golden(t *testing.T, prefix string) map[string][]byte {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join("testdata", prefix+".*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no golden files for %q: %v", prefix, err)
	}
	out := make(map[string][]byte, len(paths))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.Base(p)] = b
	}
	return out
}

func sameJSON(t *testing.T, want, got []byte) {
	t.Helper()
	var w, g any
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("invalid output %s: %v", got, err)
	}
	if !reflect.DeepEqual(w, g) {
		t.Errorf("JSON mismatch\nwant %s\ngot  %s", want, got)
	}
}

func TestServerMessagesRoundTripGolden(t *testing.T) {
	for name, data := range golden(t, "server") {
		t.Run(name, func(t *testing.T) {
			msg, err := DecodeServer(data)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := json.Marshal(msg)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			sameJSON(t, data, out)
		})
	}
}

func TestClientMessagesRoundTripGolden(t *testing.T) {
	for name, data := range golden(t, "client") {
		t.Run(name, func(t *testing.T) {
			msg, err := DecodeClient(data)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := json.Marshal(msg)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			sameJSON(t, data, out)
		})
	}
}

func TestDecodeServerTypes(t *testing.T) {
	g := golden(t, "server")
	cases := map[string]any{
		"server.trace.started.json":      TraceStarted{},
		"server.hop.json":                Hop{},
		"server.hop.update.partial.json": HopUpdate{},
		"server.trace.done.json":         TraceDone{},
		"server.error.json":              Error{},
	}
	for name, want := range cases {
		msg, err := DecodeServer(g[name])
		if err != nil {
			t.Fatal(err)
		}
		if reflect.TypeOf(msg) != reflect.TypeOf(want) {
			t.Errorf("%s decoded as %T, want %T", name, msg, want)
		}
	}
}

func TestHopUpdateKeepsAbsentAndNullDistinct(t *testing.T) {
	g := golden(t, "server")
	partial, _ := DecodeServer(g["server.hop.update.partial.json"])
	out, _ := json.Marshal(partial)
	if strings.Contains(string(out), `"host"`) {
		t.Errorf("absent field must stay absent: %s", out)
	}
	nulls, _ := DecodeServer(g["server.hop.update.nulls.json"])
	out, _ = json.Marshal(nulls)
	if !strings.Contains(string(out), `"host":null`) {
		t.Errorf("explicit null must be preserved: %s", out)
	}
}

func TestHopWithTimeoutsKeepsNullProbes(t *testing.T) {
	msg, err := DecodeServer(golden(t, "server")["server.hop.timeout.json"])
	if err != nil {
		t.Fatal(err)
	}
	h := msg.(Hop)
	if len(h.Probes) != 3 || h.Probes[0].IP != nil || h.Probes[0].RTTMs != nil || h.IP != nil {
		t.Errorf("unexpected hop: %+v", h)
	}
	if h.Annotations == nil {
		t.Error("annotations must encode as [] not null")
	}
}

func TestDecodeRejectsBadInput(t *testing.T) {
	for _, in := range []string{``, `{}`, `[]`, `{"type":"nope"}`, `{"type":"hop"`, `{"type":"hop.update"}`, `{"type":"hop.update","ttl":"3"}`, `{"type":"trace.start","target":5}`} {
		if _, err := DecodeServer([]byte(in)); err == nil {
			if _, err := DecodeClient([]byte(in)); err == nil {
				t.Errorf("expected error for %q", in)
			}
		}
	}
}
