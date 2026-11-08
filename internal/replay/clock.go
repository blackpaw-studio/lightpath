// Package replay plays back and records Lightpath event streams.
package replay

import "time"

// Clock is the time source injected into the player and recorder.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// SystemClock is the wall clock.
var SystemClock Clock = realClock{}
