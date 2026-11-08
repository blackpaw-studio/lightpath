// Render loop: everything advances through step(dtMs) on a virtual clock, so
// tests can drive frames deterministically (testhooks) and production uses rAF.

export interface Steppable {
  update(dtMs: number, nowMs: number): void;
  render(): void;
}

export interface FrameScheduler {
  request(cb: (timestampMs: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface Loop {
  /** Advance dtMs of virtual time; `render: false` skips the draw (test mode records poses without paying for pixels). */
  step(dtMs: number, render?: boolean): void;
  start(): void;
  stop(): void;
  now(): number;
}

/** Longest frame the simulation advances in one step (backgrounded tabs, debugger pauses). */
export const MAX_DT_MS = 100;

export const createLoop = (target: Steppable, scheduler?: FrameScheduler): Loop => {
  let now = 0;
  let running = false;
  let handle: unknown = null;
  let lastTs: number | null = null;

  const step = (dtMs: number, render = true): void => {
    const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS);
    now += dt;
    target.update(dt, now);
    if (render) target.render();
  };

  const frame = (ts: number): void => {
    if (!running || !scheduler) return;
    step(lastTs === null ? 0 : ts - lastTs);
    lastTs = ts;
    handle = scheduler.request(frame);
  };

  return {
    step,
    now: () => now,
    start: () => {
      if (running || !scheduler) return;
      running = true;
      lastTs = null;
      handle = scheduler.request(frame);
    },
    stop: () => {
      running = false;
      if (scheduler && handle !== null) scheduler.cancel(handle);
      handle = null;
    },
  };
};

export const rafScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h as number),
};
