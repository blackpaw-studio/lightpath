import { describe, expect, it } from "vitest";
import { checkTrace, type Frame } from "./invariants";

const opts = { maxJumpPx: 40, flickerWindowMs: 1000 };
const frames = (xs: (number | null)[], dt = 16): Frame[] =>
  xs.map((x, i) => ({ tMs: i * dt, entities: { n1: x === null ? { x: 0, y: 0, visible: false } : { x, y: 0, visible: true } } }));

describe("checkTrace", () => {
  it("GREEN on a smooth trace", () => {
    expect(checkTrace(frames([0, 10, 20, 30, 40, 50]), opts)).toEqual([]);
  });
  it("RED on a teleport", () => {
    const v = checkTrace(frames([0, 10, 20, 400, 410]), opts);
    expect(v).toEqual([expect.objectContaining({ kind: "jump", id: "n1", frame: 3 })]);
  });
  it("exactly maxJumpPx is allowed", () => {
    expect(checkTrace(frames([0, 40]), opts)).toEqual([]);
  });
  it("RED on visible→hidden→visible within the window", () => {
    const v = checkTrace(frames([0, 10, null, null, 20, 30]), opts);
    expect(v.map((x) => x.kind)).toEqual(["flicker"]);
    expect(v[0]).toMatchObject({ id: "n1", frame: 4 });
  });
  it("does not report jumps across a hidden gap", () => {
    expect(checkTrace(frames([0, null, 500], 2000), opts)).toEqual([]);
  });
  it("a long hide beyond the window is not a flicker", () => {
    expect(checkTrace(frames([0, null, 10], 600), opts)).toEqual([]);
  });
  it("entity appearing for the first time is fine; absent counts as hidden", () => {
    const fs: Frame[] = [
      { tMs: 0, entities: {} },
      { tMs: 16, entities: { a: { x: 0, y: 0, visible: true } } },
      { tMs: 32, entities: {} },
      { tMs: 48, entities: { a: { x: 1, y: 0, visible: true } } },
    ];
    expect(checkTrace(fs, opts).map((v) => v.kind)).toEqual(["flicker"]);
  });
  it("tracks entities independently", () => {
    const fs: Frame[] = [
      { tMs: 0, entities: { a: { x: 0, y: 0, visible: true }, b: { x: 0, y: 0, visible: true } } },
      { tMs: 16, entities: { a: { x: 5, y: 0, visible: true }, b: { x: 300, y: 0, visible: true } } },
    ];
    expect(checkTrace(fs, opts)).toEqual([expect.objectContaining({ kind: "jump", id: "b" })]);
  });
});
