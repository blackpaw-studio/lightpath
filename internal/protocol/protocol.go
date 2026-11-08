// Package protocol defines the Lightpath WebSocket event types. It mirrors
// ui/src/protocol.ts; keep both in sync and covered by testdata/*.json.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

type GeoSource string

const (
	GeoAPI       GeoSource = "api"
	GeoHostname  GeoSource = "hostname"
	GeoLocal     GeoSource = "local"
	GeoEstimated GeoSource = "estimated"
)

type ErrorCode string

const (
	ErrInvalidTarget     ErrorCode = "invalid_target"
	ErrBadMessage        ErrorCode = "bad_message"
	ErrTracerouteMissing ErrorCode = "traceroute_missing"
	ErrTracerouteFailed  ErrorCode = "traceroute_failed"
	ErrBusyReplay        ErrorCode = "busy_replay"
	ErrBusy              ErrorCode = "busy" // server-wide trace limit reached
)

// Message type discriminators.
const (
	TypeTraceStart   = "trace.start"
	TypeTraceCancel  = "trace.cancel"
	TypeTraceStarted = "trace.started"
	TypeHop          = "hop"
	TypeHopUpdate    = "hop.update"
	TypeTraceDone    = "trace.done"
	TypeError        = "error"
)

// ClientMsg is a client → agent message: TraceStart or TraceCancel.
type ClientMsg interface{ clientMsg() }

// ServerMsg is an agent → client message: TraceStarted, Hop, HopUpdate,
// TraceDone or Error.
type ServerMsg interface{ serverMsg() }

type TraceStart struct {
	Target string `json:"target"`
}

type TraceCancel struct{}

type Probe struct {
	IP    *string  `json:"ip"`
	RTTMs *float64 `json:"rttMs"`
}

type Origin struct {
	PublicIP *string  `json:"publicIp"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	City     *string  `json:"city"`
	ASN      *int     `json:"asn"`
	Org      *string  `json:"org"`
}

type TraceStarted struct {
	Target     string  `json:"target"`
	ResolvedIP *string `json:"resolvedIp"`
	Origin     Origin  `json:"origin"`
}

type Hop struct {
	TTL         int       `json:"ttl"`
	Probes      []Probe   `json:"probes"`
	IP          *string   `json:"ip"`
	Host        *string   `json:"host"`
	ASN         *int      `json:"asn"`
	Org         *string   `json:"org"`
	Lat         *float64  `json:"lat"`
	Lon         *float64  `json:"lon"`
	City        *string   `json:"city"`
	GeoSource   GeoSource `json:"geoSource"`
	Annotations []string  `json:"annotations"`
}

// HopUpdate carries only the changed fields of a hop, so "absent" (unchanged)
// and null (cleared) stay distinct. Keys are the Hop JSON names except
// "probes"; "type" and "ttl" are always present. Build with NewHopUpdate.
type HopUpdate map[string]any

type TraceDone struct {
	Reached bool `json:"reached"`
}

type Error struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

func (TraceStart) clientMsg()  {}
func (TraceCancel) clientMsg() {}

func (TraceStarted) serverMsg() {}
func (Hop) serverMsg()          {}
func (HopUpdate) serverMsg()    {}
func (TraceDone) serverMsg()    {}
func (Error) serverMsg()        {}

var hopUpdateFields = map[string]bool{
	"ip": true, "host": true, "asn": true, "org": true, "lat": true,
	"lon": true, "city": true, "geoSource": true, "annotations": true,
}

// NewHopUpdate returns an update for ttl containing a copy of fields.
func NewHopUpdate(ttl int, fields map[string]any) HopUpdate {
	u := HopUpdate{"type": TypeHopUpdate, "ttl": ttl}
	for k, v := range fields {
		u[k] = v
	}
	return u
}

func marshalTyped(typ string, v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	head := []byte(`{"type":"` + typ + `"`)
	if string(body) == "{}" {
		return append(head, '}'), nil
	}
	return append(head, append([]byte{','}, body[1:]...)...), nil
}

func (m TraceStart) MarshalJSON() ([]byte, error) {
	type plain TraceStart
	return marshalTyped(TypeTraceStart, plain(m))
}

func (m TraceCancel) MarshalJSON() ([]byte, error) { return marshalTyped(TypeTraceCancel, struct{}{}) }

func (m TraceStarted) MarshalJSON() ([]byte, error) {
	type plain TraceStarted
	return marshalTyped(TypeTraceStarted, plain(m))
}

func (m Hop) MarshalJSON() ([]byte, error) {
	type plain Hop
	if m.Probes == nil {
		m.Probes = []Probe{}
	}
	if m.Annotations == nil {
		m.Annotations = []string{}
	}
	return marshalTyped(TypeHop, plain(m))
}

func (m TraceDone) MarshalJSON() ([]byte, error) {
	type plain TraceDone
	return marshalTyped(TypeTraceDone, plain(m))
}

func (m Error) MarshalJSON() ([]byte, error) {
	type plain Error
	return marshalTyped(TypeError, plain(m))
}

// MarshalJSON forces the discriminator so a hand-built map cannot mislabel it.
func (m HopUpdate) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	out["type"] = TypeHopUpdate
	return json.Marshal(out)
}

func peekType(data []byte) (string, error) {
	var head struct {
		Type *string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return "", fmt.Errorf("protocol: invalid JSON: %w", err)
	}
	if head.Type == nil {
		return "", errors.New("protocol: missing type")
	}
	return *head.Type, nil
}

// strict unmarshals data into v, rejecting unknown fields other than the
// "type" discriminator.
func strict(data []byte, v any) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("protocol: invalid JSON: %w", err)
	}
	delete(raw, "type")
	rest, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(rest))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("protocol: %w", err)
	}
	return nil
}

// DecodeClient parses a client → agent message.
func DecodeClient(data []byte) (ClientMsg, error) {
	typ, err := peekType(data)
	if err != nil {
		return nil, err
	}
	switch typ {
	case TypeTraceStart:
		var m TraceStart
		if err := strict(data, &m); err != nil {
			return nil, err
		}
		return m, nil
	case TypeTraceCancel:
		var m TraceCancel
		if err := strict(data, &m); err != nil {
			return nil, err
		}
		return m, nil
	}
	return nil, fmt.Errorf("protocol: unknown client message type %q", typ)
}

// DecodeServer parses an agent → client message.
func DecodeServer(data []byte) (ServerMsg, error) {
	typ, err := peekType(data)
	if err != nil {
		return nil, err
	}
	switch typ {
	case TypeTraceStarted:
		return decodeAs[TraceStarted](data)
	case TypeHop:
		return decodeAs[Hop](data)
	case TypeHopUpdate:
		return decodeHopUpdate(data)
	case TypeTraceDone:
		return decodeAs[TraceDone](data)
	case TypeError:
		return decodeAs[Error](data)
	}
	return nil, fmt.Errorf("protocol: unknown server message type %q", typ)
}

func decodeAs[T ServerMsg](data []byte) (ServerMsg, error) {
	var m T
	if err := strict(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func decodeHopUpdate(data []byte) (ServerMsg, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("protocol: invalid JSON: %w", err)
	}
	var ttl int
	rawTTL, ok := raw["ttl"]
	if !ok {
		return nil, errors.New("protocol: hop.update missing ttl")
	}
	if err := json.Unmarshal(rawTTL, &ttl); err != nil {
		return nil, fmt.Errorf("protocol: hop.update ttl: %w", err)
	}
	fields := make(map[string]any, len(raw))
	for k, v := range raw {
		if k == "type" || k == "ttl" {
			continue
		}
		if !hopUpdateFields[k] {
			return nil, fmt.Errorf("protocol: hop.update has unknown field %q", k)
		}
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			return nil, fmt.Errorf("protocol: hop.update %s: %w", k, err)
		}
		fields[k] = val
	}
	return NewHopUpdate(ttl, fields), nil
}
