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

describe("world-space jumps (maxJumpWorld)", () => {
  const wopts = { ...opts, maxJumpWorld: 0.2 };
  // A gate re-laid out in depth: it slides straight along the view ray, so its
  // screen position never changes, but it teleports 0.6 world units.
  const depthTrace = (zs: number[]): Frame[] =>
    zs.map((z, i) => ({ tMs: i * 16, entities: { g: { x: 640, y: 360, visible: true, world: [0, 0, z] } } }));

  it("RED on a teleport along the view ray that screen space cannot see", () => {
    const fs = depthTrace([1, 1.05, 1.65, 1.7]);
    expect(checkTrace(fs, opts)).toEqual([]);
    expect(checkTrace(fs, wopts)).toEqual([expect.objectContaining({ kind: "worldJump", id: "g", frame: 2 })]);
  });
  it("GREEN when the same move glides", () => {
    expect(checkTrace(depthTrace([1, 1.15, 1.3, 1.45, 1.6]), wopts)).toEqual([]);
  });
  it("checks world continuity even while the entity is off-screen", () => {
    const fs: Frame[] = [0, 0, 3].map((z, i) => ({
      tMs: i * 16, entities: { g: { x: 0, y: 0, visible: false, world: [0, 0, z] } },
    }));
    expect(checkTrace(fs, wopts).map((v) => v.kind)).toEqual(["worldJump"]);
  });
  it("an absent frame breaks the chain (entity removed, then re-added)", () => {
    const fs: Frame[] = [
      { tMs: 0, entities: { g: { x: 0, y: 0, visible: false, world: [0, 0, 0] } } },
      { tMs: 16, entities: {} },
      { tMs: 32, entities: { g: { x: 0, y: 0, visible: false, world: [5, 0, 0] } } },
    ];
    expect(checkTrace(fs, wopts)).toEqual([]);
  });
  it("flags a non-finite world position", () => {
    const fs = depthTrace([1, NaN]);
    expect(checkTrace(fs, wopts).map((v) => v.kind)).toEqual(["invalid"]);
  });
});

describe("camera cuts", () => {
  const cutTrace = (cutAt: number | null): Frame[] =>
    [0, 10, 500, 510].map((x, i) => ({
      tMs: i * 16, cut: i === cutAt, entities: { n: { x, y: 0, visible: true, world: [1, 0, 0] } },
    }));

  it("a declared cut excuses the screen jump on that frame only", () => {
    expect(checkTrace(cutTrace(2), { ...opts, maxJumpWorld: 0.1 })).toEqual([]);
    expect(checkTrace(cutTrace(1), { ...opts, maxJumpWorld: 0.1 }).map((v) => v.kind)).toEqual(["jump"]);
  });
  it("a cut never excuses a world-space teleport", () => {
    const fs: Frame[] = [0, 1].map((i) => ({
      tMs: i * 16, cut: i === 1, entities: { n: { x: i * 400, y: 0, visible: true, world: [i * 3, 0, 0] } },
    }));
    expect(checkTrace(fs, { ...opts, maxJumpWorld: 0.1 }).map((v) => v.kind)).toEqual(["worldJump"]);
  });
});
