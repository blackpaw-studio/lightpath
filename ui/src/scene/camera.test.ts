import { describe, expect, it } from "vitest";
import { angularDistance, latLonToVec3 } from "../geo";
import { Vector3 } from "three";
import { checkTrace, type Frame } from "../invariants";
import { clampLatitude, createCameraRig, fitDistance, frameTarget, springStep } from "./camera";

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

  it("reports the angular radius of the framed route", () => {
    expect(frameTarget([a, b]).span).toBeCloseTo(angularDistance(a, b) / 2, 2);
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
  // Angle off the view axis of a unit-sphere point `theta` from the camera direction.
  const offAxis = (d: number, theta: number) => Math.atan(Math.sin(theta) / (d - Math.cos(theta)));

  it("pulls back further for wider spans", () => {
    const ds = [0.05, 0.4, 0.9, 1.4].map((t) => fitDistance([t], 16 / 9, 35));
    ds.slice(1).forEach((d, i) => expect(d).toBeGreaterThanOrEqual(ds[i]!));
    expect(ds[3]).toBeGreaterThan(ds[0]!);
  });

  it("keeps every framed point inside the narrower half-FOV, on portrait too", () => {
    for (const aspect of [16 / 9, 1, 375 / 812]) {
      const vHalf = (35 * Math.PI) / 360;
      const hHalf = Math.atan(Math.tan(vHalf) * aspect);
      for (const theta of [0.3, 0.8, 1.2, 1.5]) {
        const d = fitDistance([theta, 0.1], aspect, 35);
        expect(offAxis(d, theta)).toBeLessThan(Math.min(vHalf, hHalf));
      }
    }
  });

  it("backs off further on portrait than landscape", () => {
    expect(fitDistance([1], 375 / 812, 35)).toBeGreaterThan(fitDistance([1], 16 / 9, 35));
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

describe("createCameraRig reframing", () => {
  // Brooklyn → Tokyo via Europe and India, revealed one hop every 400 ms.
  const route = [
    [40.68, -73.94], [40.71, -74.01], [39.04, -77.49], [51.51, -0.13], [52.37, 4.9], [50.11, 8.68],
    [19.08, 72.88], [1.35, 103.82], [35.68, 139.69],
  ].map(([lat, lon]) => latLonToVec3(lat!, lon!));

  const run = (aspect: number): Frame[] => {
    const rig = createCameraRig(aspect);
    const frames: Frame[] = [];
    const v = new Vector3();
    for (let i = 0, t = 0; i < route.length; i++) {
      rig.frame(route.slice(0, i + 1), false);
      for (let f = 0; f < 24; f++, t += 1000 / 60) {
        rig.update(1000 / 60);
        rig.camera.updateMatrixWorld();
        frames.push({
          tMs: t,
          entities: Object.fromEntries(route.slice(0, i + 1).map((p, k) => {
            v.set(...p).project(rig.camera);
            return [String(k), { x: v.x * 1000, y: v.y * 1000, visible: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 }];
          })),
        });
      }
    }
    return frames;
  };

  it.each([["desktop", 16 / 9], ["phone", 375 / 812]])("never pans a framed hop out of view and back (%s)", (_, aspect) => {
    expect(checkTrace(run(aspect), { maxJumpPx: Infinity, flickerWindowMs: 1000 })).toEqual([]);
  });
});
