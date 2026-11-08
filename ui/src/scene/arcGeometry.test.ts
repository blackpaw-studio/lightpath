import { describe, expect, it } from "vitest";
import { arcPoints, latLonToVec3, type Vec3 } from "../geo";
import { writeArcPoints } from "./arcGeometry";

const N = 64;
/** Reference: geo.arcPoints on unit endpoints, radius blended between the endpoint radii. */
const reference = (a: Vec3, b: Vec3): number[] => {
  const ra = Math.hypot(...a);
  const rb = Math.hypot(...b);
  const ua = a.map((x) => x / ra) as unknown as Vec3;
  const ub = b.map((x) => x / rb) as unknown as Vec3;
  return arcPoints(ua, ub, N).flatMap((p, i) => p.map((x) => x * (ra + ((rb - ra) * i) / N)));
};

describe("writeArcPoints", () => {
  it.each([
    ["transatlantic", latLonToVec3(40.7, -74), latLonToVec3(51.5, 0)],
    ["short hop", latLonToVec3(40.7, -74), latLonToVec3(40.71, -74.01)],
    ["antipodal", latLonToVec3(0, 0), latLonToVec3(0, 180)],
    ["near pole", latLonToVec3(89.9, 0), latLonToVec3(60, 90)],
    ["off-sphere endpoints", [1.4, 0.2, -0.3] as Vec3, [0.2, 1.1, 0.9] as Vec3],
  ])("matches geo.arcPoints (%s)", (_, a, b) => {
    const out = new Float32Array((N + 1) * 3);
    writeArcPoints(out, a, b, N);
    reference(a, b).forEach((x, i) => expect(out[i]).toBeCloseTo(x, 5));
  });

  it("writes identical endpoints as a degenerate arc at the point", () => {
    const p = latLonToVec3(10, 20);
    const out = new Float32Array((N + 1) * 3);
    writeArcPoints(out, p, p, N);
    expect(out[N * 3]).toBeCloseTo(p[0], 6);
    expect(out[N * 3 + 2]).toBeCloseTo(p[2], 6);
  });
});
