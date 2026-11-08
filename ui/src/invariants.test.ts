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

describe("invalid coordinates", () => {
  it("flags a visible entity with non-finite position", () => {
    const fs: Frame[] = [
      { tMs: 0, entities: { a: { x: 0, y: 0, visible: true } } },
      { tMs: 16, entities: { a: { x: NaN, y: 0, visible: true } } },
      { tMs: 32, entities: { a: { x: 0, y: Infinity, visible: true } } },
    ];
    const kinds = checkTrace(fs, opts).map((v) => v.kind);
    expect(kinds.filter((k) => k === "invalid")).toHaveLength(2);
  });
});

describe("checkTrace camera cuts", () => {
  const withCut = (fs: Frame[], at: number): Frame[] => fs.map((f, i) => (i === at ? { ...f, cut: true } : f));

  it("exempts only the jump into a frame marked cut", () => {
    expect(checkTrace(withCut(frames([0, 10, 400, 410]), 2), opts)).toEqual([]);
    const v = checkTrace(withCut(frames([0, 10, 400, 900]), 2), opts);
    expect(v).toEqual([expect.objectContaining({ kind: "jump", frame: 3 })]);
  });

  it("still reports flicker across a cut", () => {
    const v = checkTrace(withCut(frames([0, null, 400]), 2), opts);
    expect(v.map((x) => x.kind)).toEqual(["flicker"]);
  });
});
