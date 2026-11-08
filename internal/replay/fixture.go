package replay

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// Version is the only fixture format version this package reads and writes.
const Version = 1

// Event is one server → client message at an offset from trace start.
type Event struct {
	T   time.Duration
	Msg protocol.ServerMsg
}

// Fixture is a recorded event stream.
type Fixture struct {
	Version    int
	RecordedAt time.Time
	Events     []Event
}

type fileFormat struct {
	Version    int         `json:"version"`
	RecordedAt time.Time   `json:"recordedAt"`
	Events     []fileEvent `json:"events"`
}

type fileEvent struct {
	T     int64           `json:"t"` // milliseconds from trace start
	Event json.RawMessage `json:"event"`
}

// LoadFile reads and validates a fixture from disk.
func LoadFile(path string) (*Fixture, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("replay: read fixture: %w", err)
	}
	f, err := Load(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("replay: %s: %w", path, err)
	}
	return f, nil
}

// Load parses and validates a fixture. Unknown fields, unsupported versions,
// undecodable events and non-monotonic offsets are errors.
func Load(r io.Reader) (*Fixture, error) {
	var ff fileFormat
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ff); err != nil {
		return nil, fmt.Errorf("invalid fixture JSON: %w", err)
	}
	if ff.Version != Version {
		return nil, fmt.Errorf("unsupported fixture version %d (want %d)", ff.Version, Version)
	}
	if len(ff.Events) == 0 {
		return nil, errors.New("fixture has no events")
	}
	events := make([]Event, len(ff.Events))
	var prev int64
	for i, fe := range ff.Events {
		if fe.T < 0 || fe.T < prev {
			return nil, fmt.Errorf("event %d: offset %d ms is negative or before the previous event", i, fe.T)
		}
		prev = fe.T
		msg, err := protocol.DecodeServer(fe.Event)
		if err != nil {
			return nil, fmt.Errorf("event %d: %w", i, err)
		}
		events[i] = Event{T: time.Duration(fe.T) * time.Millisecond, Msg: msg}
	}
	return &Fixture{Version: ff.Version, RecordedAt: ff.RecordedAt, Events: events}, nil
}
