package server

import (
	"context"
	"sync"
)

// limiter is a non-blocking counting semaphore: callers are refused, never queued.
type limiter struct{ slots chan struct{} }

func newLimiter(n int) *limiter { return &limiter{slots: make(chan struct{}, n)} }

func (l *limiter) tryAcquire() bool {
	select {
	case l.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (l *limiter) release() { <-l.slots }

// lifecycle tracks live sessions so shutdown can wait for them.
type lifecycle struct {
	mu      sync.Mutex
	closing bool
	wg      sync.WaitGroup
}

// begin registers a session; it refuses once wait has been called.
func (l *lifecycle) begin() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing {
		return false
	}
	l.wg.Add(1)
	return true
}

func (l *lifecycle) end() { l.wg.Done() }

func (l *lifecycle) wait(ctx context.Context) error {
	l.mu.Lock()
	l.closing = true
	l.mu.Unlock()
	done := make(chan struct{})
	go func() { l.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
