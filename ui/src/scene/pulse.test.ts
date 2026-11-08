import { describe, expect, it } from "vitest";
import { PULSE_MS, REST_GLOW, pulseHead, pulseIntensity } from "./pulse";

const opts = { reducedMotion: false, estimated: false, seed: 0 };

describe("pulseHead", () => {
  it("travels 0 → 1 over PULSE_MS and stays at 1", () => {
    expect(pulseHead(0)).toBe(0);
    expect(pulseHead(PULSE_MS / 2)).toBeCloseTo(0.5, 6);
    expect(pulseHead(PULSE_MS)).toBe(1);
    expect(pulseHead(PULSE_MS * 3)).toBe(1);
  });
});

describe("pulseIntensity", () => {
  it("draws nothing ahead of the head while travelling", () => {
    expect(pulseIntensity(0.9, PULSE_MS / 2, 0, opts)).toBe(0);
  });

  it("is brightest just behind the head while travelling", () => {
    const at = PULSE_MS / 2;
    const h = pulseHead(at);
    expect(pulseIntensity(h, at, 0, opts)).toBeGreaterThan(pulseIntensity(h - 0.3, at, 0, opts) * 2);
  });

  it("settles to at least the resting glow along the whole arc", () => {
    const age = PULSE_MS * 4;
    for (let u = 0; u <= 1; u += 0.1) expect(pulseIntensity(u, age, age, opts)).toBeGreaterThanOrEqual(REST_GLOW - 1e-9);
  });

  it("under reduced motion fades the whole arc in uniformly with no travelling light", () => {
    const r = { ...opts, reducedMotion: true };
    expect(pulseIntensity(0.1, 200, 200, r)).toBeCloseTo(pulseIntensity(0.9, 200, 200, r), 12);
    expect(pulseIntensity(0.5, 0, 0, r)).toBe(0);
    for (let n = 2000; n < 6000; n += 250) expect(pulseIntensity(0.5, n, n, r)).toBeCloseTo(REST_GLOW, 12);
  });

  it("estimated arcs rest dimmer", () => {
    const age = PULSE_MS * 4;
    expect(pulseIntensity(0.5, age, 0, { ...opts, estimated: true })).toBeLessThan(REST_GLOW);
  });
});
