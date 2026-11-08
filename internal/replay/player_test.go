package replay

import (
	"context"
	"testing"
	"time"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func testFixture() *Fixture {
	return &Fixture{Version: 1, Events: []Event{
		{T: 0, Msg: protocol.TraceStarted{Target: "recorded.example"}},
		{T: ms(100), Msg: protocol.Hop{TTL: 1}},
		{T: ms(250), Msg: protocol.TraceDone{Reached: true}},
	}}
}

type playback struct {
	events chan protocol.ServerMsg
	done   chan error
}

func startPlayback(ctx context.Context, p *Player, target string) *playback {
	pb := &playback{events: make(chan protocol.ServerMsg, 16), done: make(chan error, 1)}
	go func() { pb.done <- p.Trace(ctx, target, func(m protocol.ServerMsg) { pb.events <- m }) }()
	return pb
}

func (pb *playback) mustNotHaveEvent(t *testing.T) {
	t.Helper()
	select {
	case m := <-pb.events:
		t.Fatalf("event emitted early: %#v", m)
	default:
	}
}

func TestPlayerEmitsEventsAtTheirOffsets(t *testing.T) {
	clock := newFakeClock()
	pb := startPlayback(context.Background(), NewPlayer(testFixture(), clock), "ignored.example")

	// t=0 goes out immediately and carries the recorded target, not the requested one.
	started, ok := (<-pb.events).(protocol.TraceStarted)
	if !ok || started.Target != "recorded.example" {
		t.Fatalf("first event: %#v", started)
	}

	clock.BlockUntil(1)
	pb.mustNotHaveEvent(t)
	clock.Advance(ms(99))
	pb.mustNotHaveEvent(t) // 1 ms early
	clock.Advance(ms(1))
	if h, ok := (<-pb.events).(protocol.Hop); !ok || h.TTL != 1 {
		t.Fatalf("second event: %#v", h)
	}

	clock.BlockUntil(1)
	clock.Advance(ms(150)) // offsets are absolute from trace start, not gaps
	if _, ok := (<-pb.events).(protocol.TraceDone); !ok {
		t.Fatal("want trace.done at t=250")
	}
	if err := <-pb.done; err != nil {
		t.Fatalf("Trace: %v", err)
	}
}

func TestPlayerOffsetsAreRelativeToTraceStart(t *testing.T) {
	clock := newFakeClock()
	clock.Advance(time.Hour) // time passing before the trace must not matter
	pb := startPlayback(context.Background(), NewPlayer(testFixture(), clock), "x")
	<-pb.events
	clock.BlockUntil(1)
	clock.Advance(ms(100))
	if _, ok := (<-pb.events).(protocol.Hop); !ok {
		t.Fatal("want hop at +100ms")
	}
}

func TestPlayerCancelStopsPlayback(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	pb := startPlayback(ctx, NewPlayer(testFixture(), clock), "x")
	<-pb.events
	clock.BlockUntil(1)
	cancel()
	if err := <-pb.done; err != context.Canceled {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	clock.Advance(time.Hour) // nothing may be emitted after cancel
	pb.mustNotHaveEvent(t)
}

func TestPlayerCanReplayRepeatedly(t *testing.T) {
	p := NewPlayer(testFixture(), newFakeClock())
	for i := 0; i < 2; i++ {
		var n int
		ctx, cancel := context.WithCancel(context.Background())
		_ = p.Trace(ctx, "x", func(protocol.ServerMsg) { n++; cancel() })
		if n != 1 {
			t.Fatalf("run %d: emitted %d", i, n)
		}
	}
}
