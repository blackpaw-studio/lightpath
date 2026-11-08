import { describe, expect, it } from "vitest";
import { initialBudget, isSoftwareRenderer, sampleFrame, type FrameBudget } from "./frameBudget";

const feed = (b: FrameBudget, dtMs: number | ((i: number) => number), n: number): FrameBudget =>
  Array.from({ length: n }).reduce<FrameBudget>(
    (acc, _, i) => sampleFrame(acc, typeof dtMs === "number" ? dtMs : dtMs(i)), b);
/** Past the 2 s warm-up with healthy frames. */
const warm = (b: FrameBudget = initialBudget()): FrameBudget => feed(b, 16, 125);

describe("sampleFrame", () => {
  it("ignores the first ~2 s (startup hitches, shader compiles)", () => {
    const afterHitchyStart = feed(initialBudget(), 90, 23); // 2070 ms of stalls
    expect(afterHitchyStart.samples).toHaveLength(0);
    expect(feed(afterHitchyStart, 16, 400).tier).toBe("full");
  });

  it("does not judge before a full 120-frame window", () => {
    expect(feed(warm(), 40, 119).tier).toBe("full");
  });

  it("stays full when the window is within budget", () => {
    expect(feed(warm(), 16.7, 500).tier).toBe("full");
  });

  it("judges by the median, so a quarter of stalled frames cannot degrade", () => {
    expect(feed(warm(), (i) => (i % 4 === 0 ? 90 : 16), 480).tier).toBe("full");
  });

  it("treats a steady ~33.3 ms cadence as a display cap (Safari Low Power Mode), not GPU load", () => {
    expect(feed(warm(), 33.3, 600).tier).toBe("full");
    expect(feed(warm(), (i) => 33.3 + (i % 3) * 0.4 - 0.4, 600).tier).toBe("full");
  });

  it("still degrades when ~33 ms frames are erratic rather than capped", () => {
    expect(feed(warm(), (i) => (i % 2 === 0 ? 16.7 : 50), 120).tier).toBe("off");
  });

  it("drops to half when the median is over 20 ms", () => {
    expect(feed(warm(), 24, 120).tier).toBe("half");
  });

  it("drops straight to off when the median is over 28 ms (and not a display cap)", () => {
    expect(feed(warm(), 40, 120).tier).toBe("off");
  });

  it("measures a fresh window at half before turning off", () => {
    const half = feed(warm(), 24, 120);
    expect(feed(half, 30, 119).tier).toBe("half");
    expect(feed(half, 30, 120).tier).toBe("off");
  });

  it("never raises the tier again", () => {
    const half = feed(warm(), 24, 120);
    expect(feed(half, 8, 1000).tier).toBe("half");
    const off = feed(warm(), 40, 120);
    expect(feed(off, 8, 1000).tier).toBe("off");
  });

  it("caps single-frame spikes", () => {
    expect(sampleFrame(feed(warm(), 16, 119), 5000).tier).toBe("full");
  });

  it("keeps a pinned tier fixed regardless of frame time", () => {
    expect(feed(initialBudget("full", true), 50, 500).tier).toBe("full");
  });

  it("does not mutate the previous budget", () => {
    const b = warm();
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
