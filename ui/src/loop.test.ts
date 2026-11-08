import { describe, expect, it, vi } from "vitest";
import { createLoop, MAX_DT_MS } from "./loop";

const target = () => ({ update: vi.fn(), render: vi.fn() });

describe("createLoop", () => {
  it("step advances a virtual clock, then updates and renders", () => {
    const t = target();
    const loop = createLoop(t);
    loop.step(16);
    loop.step(20);
    expect(loop.now()).toBe(36);
    expect(t.update).toHaveBeenLastCalledWith(20, 36);
    expect(t.render).toHaveBeenCalledTimes(2);
  });

  it("step can skip the draw: the simulation still advances (test mode records poses without rendering)", () => {
    const t = target();
    const loop = createLoop(t);
    loop.step(16, false);
    expect(loop.now()).toBe(16);
    expect(t.update).toHaveBeenCalledWith(16, 16);
    expect(t.render).not.toHaveBeenCalled();
  });

  it("clamps dt to [0, MAX_DT_MS]", () => {
    const t = target();
    const loop = createLoop(t);
    loop.step(-5);
    loop.step(10_000);
    expect(loop.now()).toBe(MAX_DT_MS);
  });

  it("drives step from animation frames using timestamp deltas", () => {
    const t = target();
    const queue: ((ts: number) => void)[] = [];
    const loop = createLoop(t, { request: (cb) => queue.push(cb), cancel: () => undefined });
    loop.start();
    queue.shift()!(1000); // first frame: dt 0
    queue.shift()!(1016);
    expect(loop.now()).toBe(16);
    loop.stop();
    expect(queue).toHaveLength(1);
    queue.shift()!(1032); // stale callback after stop is ignored
    expect(loop.now()).toBe(16);
  });
});
