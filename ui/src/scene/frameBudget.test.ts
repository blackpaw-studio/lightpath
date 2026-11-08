import { describe, expect, it } from "vitest";
import { initialBudget, isSoftwareRenderer, sampleFrame, type FrameBudget } from "./frameBudget";

const feed = (b: FrameBudget, dtMs: number, n: number): FrameBudget =>
  Array.from({ length: n }).reduce<FrameBudget>((acc) => sampleFrame(acc, dtMs), b);

describe("sampleFrame", () => {
  it("does not judge before a full 120-frame window", () => {
    expect(feed(initialBudget(), 40, 119).tier).toBe("full");
  });

  it("stays full when the window averages within budget", () => {
    expect(feed(initialBudget(), 16.7, 500).tier).toBe("full");
  });

  it("drops to half when the window averages over 20 ms", () => {
    expect(feed(initialBudget(), 24, 120).tier).toBe("half");
  });

  it("drops straight to off when the window averages over 28 ms", () => {
    expect(feed(initialBudget(), 33, 120).tier).toBe("off");
  });

  it("measures a fresh window at half before turning off", () => {
    const half = feed(initialBudget(), 24, 120);
    expect(feed(half, 30, 119).tier).toBe("half");
    expect(feed(half, 30, 120).tier).toBe("off");
  });

  it("never raises the tier again", () => {
    const half = feed(initialBudget(), 24, 120);
    expect(feed(half, 8, 1000).tier).toBe("half");
    const off = feed(initialBudget(), 40, 120);
    expect(feed(off, 8, 1000).tier).toBe("off");
  });

  it("caps single-frame spikes so one stall does not degrade", () => {
    const b = sampleFrame(feed(initialBudget(), 16, 119), 5000);
    expect(b.tier).toBe("full");
  });

  it("keeps a pinned tier fixed regardless of frame time", () => {
    expect(feed(initialBudget("full", true), 50, 500).tier).toBe("full");
  });

  it("does not mutate the previous budget", () => {
    const b = initialBudget();
    sampleFrame(b, 40);
    expect(b.samples).toHaveLength(0);
  });
});

describe("isSoftwareRenderer", () => {
  it.each([
    ["Google SwiftShader", true],
    ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", true],
    ["llvmpipe (LLVM 15.0.7, 256 bits)", true],
    ["Microsoft Basic Render Driver", true],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)", false],
    ["", false],
  ])("%s → %s", (s, want) => expect(isSoftwareRenderer(s)).toBe(want));
});
