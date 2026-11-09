import { describe, expect, it } from "vitest";
import { angularDistance, arcPoints, latLonToVec3, slerpGreatCircle, type Vec3 } from "../geo";
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

const radiiOf = (out: Float32Array, n: number): number[] =>
  Array.from({ length: n + 1 }, (_, i) => Math.hypot(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!));

/** Number of direction changes in a series (rise → fall counts once); a unimodal hump has at most one. */
const turns = (xs: readonly number[], eps = 1e-6): number => {
  const ds = xs.slice(1).map((x, i) => x - xs[i]!).filter((d) => Math.abs(d) > eps);
  return ds.slice(1).filter((d, i) => Math.sign(d) !== Math.sign(ds[i]!)).length;
};

/** Largest angle between consecutive segments of the polyline, degrees. */
const maxTurnDeg = (out: Float32Array, n: number): number => {
  const p = (i: number): Vec3 => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!];
  let worst = 0;
  for (let i = 1; i < n; i++) {
    const a = p(i - 1), b = p(i), c = p(i + 1);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]] as const;
    const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
    worst = Math.max(worst, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
  }
  return worst;
};

describe("arc altitude", () => {
  it("a run of estimated hops on one great circle has one altitude hump", () => {
    const a = latLonToVec3(-30, -20);
    const b = latLonToVec3(55.75, 37.62);
    const theta = angularDistance(a, b);
    const hops = Array.from({ length: 6 }, (_, i) => slerpGreatCircle(a, b, i / 5));
    const chain = hops.slice(1).flatMap((p, i) => {
      const out = new Float32Array((N + 1) * 3);
      writeArcPoints(out, hops[i]!, p, N, undefined, { t0: i / 5, t1: (i + 1) / 5, theta });
      return radiiOf(out, N).slice(0, N);
    });
    expect(turns(chain)).toBe(1); // rises once, falls once
    expect(Math.min(...chain)).toBeGreaterThanOrEqual(1 - 1e-6);
  });

  it("a span that is the whole arc matches the plain arc", () => {
    const a = latLonToVec3(40.7, -74), b = latLonToVec3(51.5, 0);
    const plain = new Float32Array((N + 1) * 3), spanned = new Float32Array((N + 1) * 3);
    writeArcPoints(plain, a, b, N);
    writeArcPoints(spanned, a, b, N, undefined, { t0: 0, t1: 1, theta: angularDistance(a, b) });
    plain.forEach((x, i) => expect(spanned[i]).toBeCloseTo(x, 6));
  });

  it.each([0.01, 0.1, 0.5, 1, 2, 3, Math.PI - 0.01, Math.PI - 1e-4])(
    "a single arc of %f rad rises and falls once, stays above the surface and turns gently", (theta) => {
      const out = new Float32Array((N + 1) * 3);
      writeArcPoints(out, [1, 0, 0], [Math.cos(theta), Math.sin(theta), 0], N);
      const r = radiiOf(out, N);
      expect(turns(r)).toBeLessThanOrEqual(1);
      expect(Math.min(...r)).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(maxTurnDeg(out, N)).toBeLessThan(5);
    });
});
