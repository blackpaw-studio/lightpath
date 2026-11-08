import { describe, expect, it } from "vitest";
import { meanRtt, NO_RTT_COLOR, oklabToSrgb, rttColor, srgbToOklab } from "./color";

describe("meanRtt", () => {
  it("averages non-null probes", () => {
    expect(meanRtt([{ ip: "a", rttMs: 10 }, { ip: null, rttMs: null }, { ip: "a", rttMs: 30 }])).toBe(20);
  });
  it("is null when every probe timed out", () => {
    expect(meanRtt([{ ip: null, rttMs: null }])).toBeNull();
    expect(meanRtt([])).toBeNull();
  });
});

describe("rttColor", () => {
  it("hits the stops exactly", () => {
    expect(rttColor(20)).toBe("#22e6ff");
    expect(rttColor(80)).toBe("#9b5cff");
    expect(rttColor(200)).toBe("#ff3b4f");
  });
  it("clamps outside the range", () => {
    expect(rttColor(0)).toBe("#22e6ff");
    expect(rttColor(-5)).toBe("#22e6ff");
    expect(rttColor(5000)).toBe("#ff3b4f");
  });
  it("dim grey for null", () => {
    expect(rttColor(null)).toBe(NO_RTT_COLOR);
  });
  it("interpolates linearly in OKLab (midpoints)", () => {
    const mid = (from: string, to: string, color: string) => {
      const a = srgbToOklab(from), b = srgbToOklab(to), c = srgbToOklab(color);
      c.forEach((x, i) => expect(x).toBeCloseTo((a[i]! + b[i]!) / 2, 1));
    };
    mid("#22e6ff", "#9b5cff", rttColor(50));
    mid("#9b5cff", "#ff3b4f", rttColor(140));
  });
  it("is not an sRGB blend", () => {
    expect(rttColor(50)).not.toBe("#5ea3ff");
  });
});

describe("oklab round trip", () => {
  it("recovers sRGB", () => {
    expect(oklabToSrgb(srgbToOklab("#12ab9f"))).toBe("#12ab9f");
  });
});
