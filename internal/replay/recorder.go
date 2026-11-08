package replay

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// Recorder captures events with offsets from its creation. Safe for
// concurrent Record calls.
type Recorder struct {
	clock Clock
	start time.Time

	mu     sync.Mutex
	events []fileEvent
	err    error
}

func NewRecorder(clock Clock) *Recorder { return &Recorder{clock: clock, start: clock.Now()} }

func (r *Recorder) Record(m protocol.ServerMsg) {
	raw, err := json.Marshal(m)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.err = fmt.Errorf("replay: encode event: %w", err)
		return
	}
	r.events = append(r.events, fileEvent{T: r.clock.Now().Sub(r.start).Milliseconds(), Event: raw})
}

// Marshal renders the recording in fixture format.
func (r *Recorder) Marshal() ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return nil, r.err
	}
	ff := fileFormat{Version: Version, RecordedAt: r.start.UTC(), Events: r.events}
	if ff.Events == nil {
		ff.Events = []fileEvent{}
	}
	return json.MarshalIndent(ff, "", "  ")
}

// Source is the consumer-side shape of a trace source (matches server.TraceSource).
type Source interface {
	Trace(ctx context.Context, target string, emit func(protocol.ServerMsg)) error
}

// RecordingSource wraps a Source, forwarding events unchanged while recording
// them, and hands the finished fixture to Save when the trace returns
// (including after cancellation, so partial traces are kept).
type RecordingSource struct {
	Inner Source
	Clock Clock
	Save  func(data []byte) error

	saveMu sync.Mutex // concurrent traces must not interleave their saves
}

func (s *RecordingSource) Trace(ctx context.Context, target string, emit func(protocol.ServerMsg)) error {
	rec := NewRecorder(s.Clock)
	runErr := s.Inner.Trace(ctx, target, func(m protocol.ServerMsg) {
		rec.Record(m)
		emit(m)
	})
	data, err := rec.Marshal()
	if err == nil {
		s.saveMu.Lock()
		err = s.Save(data)
		s.saveMu.Unlock()
	}
	if runErr != nil {
		return runErr
	}
	if err != nil {
		return fmt.Errorf("replay: save recording: %w", err)
	}
	return nil
}
