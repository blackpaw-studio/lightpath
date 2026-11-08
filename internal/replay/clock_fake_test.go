package replay

import (
	"sync"
	"time"
)

// fakeClock only moves when Advance is called. BlockUntil lets a test wait,
// without sleeping, until the code under test has parked on n timers.
type fakeClock struct {
	mu     sync.Mutex
	cond   *sync.Cond
	now    time.Time
	timers []fakeTimer
}

type fakeTimer struct {
	at time.Time
	ch chan time.Time
}

func newFakeClock() *fakeClock {
	c := &fakeClock{now: time.Date(2026, 11, 7, 22, 0, 0, 0, time.UTC)}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	if d <= 0 {
		ch <- c.now
		return ch
	}
	c.timers = append(c.timers, fakeTimer{at: c.now.Add(d), ch: ch})
	c.cond.Broadcast()
	return ch
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	kept := c.timers[:0]
	for _, t := range c.timers {
		if !t.at.After(c.now) {
			t.ch <- c.now
		} else {
			kept = append(kept, t)
		}
	}
	c.timers = kept
	c.cond.Broadcast()
}

func (c *fakeClock) BlockUntil(n int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.timers) < n {
		c.cond.Wait()
	}
}
