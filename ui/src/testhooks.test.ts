import { describe, expect, it } from "vitest";
import { installTestHooks, isTestMode, projectFrame, type TestHooks } from "./testhooks";

describe("isTestMode", () => {
  it.each([["?test=1", true], ["?a=b&test=1", true], ["?test=0", false], ["", false], ["?test", false]])(
    "%s → %s", (s, want) => expect(isTestMode(s)).toBe(want));
});

describe("projectFrame", () => {
  it("marks entities visible only when opaque enough and inside the frustum", () => {
    const poses = new Map([
      [0, { pos: [0, 0, 0] as const, scale: 1, opacity: 1 }],
      [1, { pos: [1, 0, 0] as const, scale: 1, opacity: 0.005 }],
      [2, { pos: [2, 0, 0] as const, scale: 1, opacity: 1 }],
    ]);
    const f = projectFrame(50, poses, (p) => ({ x: p[0] * 10, y: 5, inFrustum: p[0] < 2 }));
    expect(f.tMs).toBe(50);
    expect(f.entities["0"]).toEqual({ x: 0, y: 5, visible: true, opacity: 1, world: [0, 0, 0] });
    expect(f.entities["1"]!.visible).toBe(false);
    expect(f.entities["2"]!.visible).toBe(false);
  });
});

describe("installTestHooks", () => {
  it("exposes hooks on the target under __lightpath", () => {
    const w: { __lightpath?: TestHooks } = {};
    const hooks = { step: () => undefined, trace: () => ({ tMs: 0, entities: {} }), state: () => null as never };
    installTestHooks(w, hooks);
    expect(w.__lightpath).toBe(hooks);
  });
});
