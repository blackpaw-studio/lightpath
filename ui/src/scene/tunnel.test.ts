import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { endCapGeometry, fillRamp, RAMP_SIZE, TUBE_R } from "./tunnel";
import { helixLocal } from "./tunnelLayout";
import type { TunnelGate } from "./tunnelLayout";

const gate = (ttl: number, s: number, color: string, broken = false): TunnelGate =>
  ({ ttl, s, color, broken, title: "", detail: "", estimated: false });

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

describe("endCapGeometry", () => {
  // The tube is open-ended: without a cap the screen-space backdrop shows
  // through the far end as a bright disc at the vanishing point.
  const length = 12;
  const cap = endCapGeometry(length);
  const pos = cap.getAttribute("position");
  const end = new Vector3(...helixLocal(length));
  const tangent = new Vector3(...helixLocal(length)).sub(new Vector3(...helixLocal(length - 1e-3))).normalize();
  const points = Array.from({ length: pos.count }, (_, i) => new Vector3().fromBufferAttribute(pos, i));

  it("closes the tube's far end: a disc centred on the curve's end, across the tangent", () => {
    for (const p of points) expect(Math.abs(p.clone().sub(end).dot(tangent))).toBeLessThan(1e-3);
    cap.computeBoundingBox();
    expect(cap.boundingBox!.getCenter(new Vector3()).distanceTo(end)).toBeLessThan(1e-3);
  });

  it("covers the whole tube cross-section without reaching far past the wall", () => {
    const radius = Math.max(...points.map((p) => p.distanceTo(end)));
    expect(radius).toBeGreaterThanOrEqual(TUBE_R);
    expect(radius).toBeLessThan(TUBE_R * 1.05);
  });

  it("samples the ramp at the far end (u = 1) so its tint matches the tail", () => {
    const uv = cap.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) expect(uv.getX(i)).toBe(1);
  });
});
