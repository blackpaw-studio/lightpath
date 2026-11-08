package replay

import (
	"context"

	"github.com/blackpaw-studio/lightpath/internal/protocol"
)

// Player replays a fixture with its original timing. It ignores the
// requested target; the recorded trace.started carries the recorded one.
type Player struct {
	fixture *Fixture
	clock   Clock
}

func NewPlayer(f *Fixture, clock Clock) *Player { return &Player{fixture: f, clock: clock} }

// Trace emits every fixture event at start+offset, returning ctx.Err() if
// cancelled first. The Player holds no per-run state, so concurrent calls
// are independent.
func (p *Player) Trace(ctx context.Context, _ string, emit func(protocol.ServerMsg)) error {
	start := p.clock.Now()
	for _, ev := range p.fixture.Events {
		if wait := start.Add(ev.T).Sub(p.clock.Now()); wait > 0 {
			select {
			case <-p.clock.After(wait):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		emit(ev.Msg)
	}
	return nil
}
