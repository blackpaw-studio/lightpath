import { describe, expect, it } from "vitest";
import { fillRamp, RAMP_SIZE } from "./tunnel";
import type { TunnelGate } from "./tunnelLayout";

const gate = (ttl: number, s: number, color: string, broken = false): TunnelGate =>
  ({ ttl, s, color, broken, title: "", detail: "" });

const texel = (data: Uint8Array, s: number, length: number): number[] => {
  const i = Math.min(Math.floor((s / length) * RAMP_SIZE), RAMP_SIZE - 1);
  return [...data.slice(i * 4, i * 4 + 3)];
};

describe("fillRamp", () => {
  const length = 16;
  const data = new Uint8Array(RAMP_SIZE * 4);
  fillRamp(data, [gate(1, 2, "#22e6ff"), gate(2, 4, "#000000", true), gate(3, 8, "#ff3b4f")], length);

  it("holds the last live gate's colour down the tail instead of extrapolating past it", () => {
    for (const s of [8.2, 10, 15.9]) expect(texel(data, s, length)).toEqual([0xff, 0x3b, 0x4f]);
  });

  it("blends between live gates and skips broken ones", () => {
    const mid = texel(data, 5, length);
    expect(mid[0]).toBeGreaterThan(0x22);
    expect(mid[0]).toBeLessThan(0xff);
    expect(mid[1]).toBeLessThan(0xe6);
    expect(mid[1]).toBeGreaterThan(0x3b);
  });
});
