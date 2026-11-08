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

// Every input ui/src/protocol.ts rejects must be rejected here too.
func TestDecodeServerRejectsWhatTheUIRejects(t *testing.T) {
	const hop = `"ttl":3,"probes":[{"ip":"198.51.100.1","rttMs":12.5}],"ip":"198.51.100.1","host":null,"asn":64501,"org":null,"lat":41.88,"lon":-87.63,"city":null,"geoSource":"api","annotations":[]`
	const origin = `{"publicIp":null,"lat":null,"lon":null,"city":null,"asn":null,"org":null}`
	valid := []string{
		`{"type":"hop",` + hop + `}`,
		`{"type":"trace.started","target":"x","resolvedIp":null,"origin":` + origin + `}`,
		`{"type":"hop.update","ttl":3,"asn":null,"geoSource":"local","annotations":["!H"]}`,
	}
	for _, in := range valid {
		if _, err := DecodeServer([]byte(in)); err != nil {
			t.Errorf("valid input rejected: %s: %v", in, err)
		}
	}
	reject := map[string]string{
		// The UI's own table.
		"empty":               ``,
		"no type":             `{}`,
		"array":               `[]`,
		"unknown type":        `{"type":"nope"}`,
		"update without ttl":  `{"type":"hop.update"}`,
		"update string ttl":   `{"type":"hop.update","ttl":"3"}`,
		"hop missing fields":  `{"type":"hop","ttl":1}`,
		"done string reached": `{"type":"trace.done","reached":"yes"}`,
		// Missing required fields.
		"done missing reached": `{"type":"trace.done"}`,
		"error missing msg":    `{"type":"error","code":"busy"}`,
		"started no origin":    `{"type":"trace.started","target":"x","resolvedIp":null}`,
		"started no resolved":  `{"type":"trace.started","target":"x","origin":` + origin + `}`,
		"origin missing asn":   `{"type":"trace.started","target":"x","resolvedIp":null,"origin":{"publicIp":null,"lat":null,"lon":null,"city":null,"org":null}}`,
		"hop missing city":     `{"type":"hop",` + strings.Replace(hop, `"city":null,`, ``, 1) + `}`,
		"probe missing rtt":    `{"type":"hop",` + strings.Replace(hop, `,"rttMs":12.5`, ``, 1) + `}`,
		// Null where the UI requires a value.
		"null target":     `{"type":"trace.started","target":null,"resolvedIp":null,"origin":` + origin + `}`,
		"null origin":     `{"type":"trace.started","target":"x","resolvedIp":null,"origin":null}`,
		"null probes":     `{"type":"hop",` + strings.Replace(hop, `"probes":[{"ip":"198.51.100.1","rttMs":12.5}]`, `"probes":null`, 1) + `}`,
		"null probe":      `{"type":"hop",` + strings.Replace(hop, `[{"ip":"198.51.100.1","rttMs":12.5}]`, `[null]`, 1) + `}`,
		"null annotation": `{"type":"hop",` + strings.Replace(hop, `"annotations":[]`, `"annotations":[null]`, 1) + `}`,
		"null geoSource":  `{"type":"hop",` + strings.Replace(hop, `"geoSource":"api"`, `"geoSource":null`, 1) + `}`,
		"null ttl":        `{"type":"hop",` + strings.Replace(hop, `"ttl":3`, `"ttl":null`, 1) + `}`,
		"null reached":    `{"type":"trace.done","reached":null}`,
		"null error code": `{"type":"error","code":null,"message":"m"}`,
		"update null ttl": `{"type":"hop.update","ttl":null}`,
		// Invalid enum values.
		"bad geoSource":   `{"type":"hop",` + strings.Replace(hop, `"geoSource":"api"`, `"geoSource":"gps"`, 1) + `}`,
		"empty geoSource": `{"type":"hop",` + strings.Replace(hop, `"geoSource":"api"`, `"geoSource":""`, 1) + `}`,
		"bad error code":  `{"type":"error","code":"oops","message":"m"}`,
		"update bad geo":  `{"type":"hop.update","ttl":3,"geoSource":"gps"}`,
		"update null geo": `{"type":"hop.update","ttl":3,"geoSource":null}`,
		// Mistyped values.
		"fractional asn":     `{"type":"hop",` + strings.Replace(hop, `"asn":64501`, `"asn":1.5`, 1) + `}`,
		"string lat":         `{"type":"hop",` + strings.Replace(hop, `"lat":41.88`, `"lat":"41"`, 1) + `}`,
		"fractional ttl":     `{"type":"hop.update","ttl":1.5}`,
		"update string asn":  `{"type":"hop.update","ttl":3,"asn":"64501"}`,
		"update float asn":   `{"type":"hop.update","ttl":3,"asn":1.5}`,
		"update number host": `{"type":"hop.update","ttl":3,"host":5}`,
		"update string lat":  `{"type":"hop.update","ttl":3,"lat":"1"}`,
		"update bool city":   `{"type":"hop.update","ttl":3,"city":true}`,
		"update obj org":     `{"type":"hop.update","ttl":3,"org":{}}`,
		"update ip array":    `{"type":"hop.update","ttl":3,"ip":[]}`,
		"update annots str":  `{"type":"hop.update","ttl":3,"annotations":"!H"}`,
		"update annots num":  `{"type":"hop.update","ttl":3,"annotations":[1]}`,
		"update annots null": `{"type":"hop.update","ttl":3,"annotations":null}`,
	}
	for name, in := range reject {
		if msg, err := DecodeServer([]byte(in)); err == nil {
			t.Errorf("%s: accepted %s as %#v", name, in, msg)
		}
	}
}

func TestDecodeClientRejectsWhatTheUIRejects(t *testing.T) {
	for name, in := range map[string]string{
		"missing target": `{"type":"trace.start"}`,
		"null target":    `{"type":"trace.start","target":null}`,
		"number target":  `{"type":"trace.start","target":5}`,
	} {
		if _, err := DecodeClient([]byte(in)); err == nil {
			t.Errorf("%s: accepted %s", name, in)
		}
	}
}

func TestNewHopUpdateRejectsUnknownAndReservedKeys(t *testing.T) {
	for _, key := range []string{"probes", "ttl", "type", "bogus"} {
		if _, err := NewHopUpdate(3, map[string]any{key: 1}); err == nil {
			t.Errorf("NewHopUpdate accepted key %q", key)
		}
	}
	u, err := NewHopUpdate(3, map[string]any{"asn": 64501, "host": nil})
	if err != nil || u["asn"] != 64501 || u["ttl"] != 3 {
		t.Errorf("valid update = %v, %v", u, err)
	}
}
