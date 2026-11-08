import { describe, expect, it } from "vitest";
import { angularDistance, latLonToVec3 } from "../geo";
import { clampLatitude, fitDistance, frameTarget, springStep } from "./camera";

describe("springStep (critically damped)", () => {
  it("converges to the target without overshoot", () => {
    let s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 300; i++) {
      s = springStep(s, 1, 16, 6);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(1, 4);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("is the identity for dt = 0 and stable for huge dt", () => {
    expect(springStep({ x: 0.3, v: 2 }, 1, 0, 6)).toEqual({ x: 0.3, v: 2 });
    const big = springStep({ x: 0, v: 0 }, 1, 1e6, 6);
    expect(big.x).toBeCloseTo(1, 6);
  });
});

describe("frameTarget", () => {
  const a = latLonToVec3(40, -74);
  const b = latLonToVec3(51, 0);

  it("looks at the midpoint between origin and newest hop", () => {
    const { dir } = frameTarget([a, b]);
    expect(angularDistance(dir, a)).toBeCloseTo(angularDistance(dir, b), 2);
  });

  it("centres on the route's extent, not on where hops cluster", () => {
    const cluster = Array.from({ length: 6 }, () => a);
    const { dir } = frameTarget([...cluster, b]);
    expect(angularDistance(dir, a)).toBeCloseTo(angularDistance(dir, b), 2);
  });

  it("pulls back further for wider spans", () => {
    const near = frameTarget([a, latLonToVec3(41, -75)]).distance;
    const far = frameTarget([a, b]).distance;
    const huge = frameTarget([a, latLonToVec3(-33, 151)]).distance;
    expect(near).toBeLessThan(far);
    expect(far).toBeLessThan(huge);
  });

  it("frames the whole route, not just its ends", () => {
    const via = [latLonToVec3(40, -74), latLonToVec3(51, 0), latLonToVec3(19, 73), latLonToVec3(35, 140)];
    const { dir } = frameTarget(via);
    const ends = frameTarget([via[0]!, via[3]!]);
    expect(angularDistance(dir, via[2]!)).toBeLessThan(angularDistance(ends.dir, via[2]!));
  });

  it("falls back to the newest point for antipodal pairs", () => {
    const { dir } = frameTarget([latLonToVec3(0, 0), latLonToVec3(0, 180)]);
    expect(angularDistance(dir, latLonToVec3(0, 180))).toBeLessThan(1e-9);
  });
});

describe("fitDistance", () => {
  it("leaves landscape views alone and backs off on narrow portrait ones", () => {
    expect(fitDistance(3, 16 / 9, 35)).toBe(3);
    expect(fitDistance(3, 375 / 812, 35)).toBeGreaterThan(3);
  });
});

describe("clampLatitude", () => {
  it("keeps longitude and limits latitude so north stays up", () => {
    const d = clampLatitude(latLonToVec3(85, 40), 50);
    expect(angularDistance(d, latLonToVec3(50, 40))).toBeLessThan(1e-9);
    expect(angularDistance(clampLatitude(latLonToVec3(-70, -10), 50), latLonToVec3(-50, -10))).toBeLessThan(1e-9);
    expect(clampLatitude(latLonToVec3(20, 5), 50)).toEqual(latLonToVec3(20, 5));
  });
});
