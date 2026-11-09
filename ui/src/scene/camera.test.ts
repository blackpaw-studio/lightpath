import { describe, expect, it } from "vitest";
import { angularDistance, latLonToVec3 } from "../geo";
import { Vector3 } from "three";
import { checkTrace, type Frame } from "../invariants";
import type { Vec3 } from "../geo";
import {
  applyFraming, clampLatitude, createCameraRig, FIT_MARGIN, fitInRect, FOV_DEG, frameTarget, MAX_DISTANCE, solveFraming, springStep,
} from "./camera";
import { rotateY } from "./globePoses";
import { MAX_JUMP_PX } from "./motionBudget";
import { FULL_NDC, safeRect, toNdc, type NdcRect } from "./safeArea";

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

describe("applyFraming", () => {
  const route = [
    [40.68, -73.94], [40.71, -74.01], [39.04, -77.49], [51.51, -0.13], [52.37, 4.9], [50.11, 8.68],
    [19.08, 72.88], [1.35, 103.82], [35.68, 139.69],
  ].map(([lat, lon]) => latLonToVec3(lat!, lon!));

  it("glides (never cuts) with full motion", () => {
    const rig = createCameraRig(16 / 9);
    expect(route.map((_, i) => applyFraming(rig, route.slice(0, i + 1), false))).not.toContain(true);
  });

  it("under reduced motion holds still while the newest hop fits, cutting only when it would leave", () => {
    const rig = createCameraRig(16 / 9);
    const cuts = route.map((_, i) => {
      const before = rig.camera.position.clone();
      const cut = applyFraming(rig, route.slice(0, i + 1), true);
      expect(cut).toBe(!before.equals(rig.camera.position));
      expect(rig.contains([route[i]!])).toBe(true);
      return cut;
    });
    // Brooklyn's local hops share one framing: at most one cut for hops 1–3.
    expect(cuts.slice(1, 3)).toEqual([false, false]);
    expect(cuts.filter(Boolean).length).toBeLessThan(route.length / 2);
  });
});

// Framing into the area the HUD leaves free.
const NY = latLonToVec3(40.68, -73.94);
const MOSCOW = latLonToVec3(55.75, 37.62);
const LONG_HAUL = [NY, [51.51, -0.13], [59.33, 18.07], [6.52, 3.38], [55.75, 37.62]]
  .map((p) => (Array.isArray(p) ? latLonToVec3(p[0]!, p[1]!) : p)) as Vec3[];
const DESKTOP = { w: 1280, h: 720 };
const PHONE = { w: 375, h: 812 };
const LEFT_COLUMN: NdcRect = toNdc(safeRect(DESKTOP, [{ left: 16, top: 16, right: 396, bottom: 704 }]), DESKTOP);
const BAND: NdcRect = toNdc(safeRect(PHONE, [{ left: 10, top: 10, right: 365, bottom: 120 }, { left: 0, top: 438, right: 375, bottom: 812 }]), PHONE);

const ndcOf = (rig: ReturnType<typeof createCameraRig>, p: Vec3): Vector3 => {
  rig.camera.updateMatrixWorld(true);
  return new Vector3(...p).project(rig.camera);
};
const faces = (rig: ReturnType<typeof createCameraRig>, p: Vec3): boolean => {
  const c = rig.camera.position;
  return p[0] * c.x + p[1] * c.y + p[2] * c.z > 1;
};
const insideRect = (v: Vector3, r: NdcRect, margin = FIT_MARGIN): boolean =>
  Math.abs(v.x - r.cx) <= r.hx * margin + 1e-6 && Math.abs(v.y - r.cy) <= r.hy * margin + 1e-6;
const settle = (rig: ReturnType<typeof createCameraRig>, ms = 8000): void => {
  for (let t = 0; t < ms; t += 1000 / 60) rig.update(1000 / 60);
};

describe("fitInRect", () => {
  const dir = solveFraming(LONG_HAUL, 16 / 9, FOV_DEG, LEFT_COLUMN).dir;

  it("pulls back further for a smaller free area", () => {
    const full = fitInRect(LONG_HAUL, dir, 16 / 9, FOV_DEG, FULL_NDC)!;
    const short = fitInRect(LONG_HAUL, dir, 16 / 9, FOV_DEG, { cx: 0, cy: 0, hx: 1, hy: 0.3 })!;
    const narrow = fitInRect(LONG_HAUL, dir, 16 / 9, FOV_DEG, { cx: 0, cy: 0, hx: 0.2, hy: 1 })!;
    expect(short).toBeGreaterThan(full);
    expect(narrow).toBeGreaterThan(full);
  });

  it("is null when a point is past the limb of the view direction", () => {
    const back = latLonToVec3(-40, 106); // antipode of New York
    expect(fitInRect([NY, back], NY, 16 / 9, FOV_DEG, FULL_NDC)).toBeNull();
  });

  it("is null when the fit would need more than the maximum distance", () => {
    const near = latLonToVec3(40.68 - 88, -73.94); // 88° off: it clears the horizon only from beyond MAX_DISTANCE
    expect(fitInRect([NY, near], NY, 16 / 9, FOV_DEG, LEFT_COLUMN)).toBeNull();
  });
});

describe("solveFraming", () => {
  it("fits the New York to Moscow path into the free area of a wide screen, every node facing the camera", () => {
    const { dir, dist } = solveFraming(LONG_HAUL, 16 / 9, FOV_DEG, LEFT_COLUMN);
    expect(dist).toBeLessThan(MAX_DISTANCE);
    LONG_HAUL.forEach((p) => expect(p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2]).toBeGreaterThan(1 / dist));
  });

  it("falls back to the origin–end great-circle midpoint at the maximum distance when the path is too wide", () => {
    const far = latLonToVec3(-30, 100);
    const { dir, dist } = solveFraming([NY, far], 16 / 9, FOV_DEG, FULL_NDC);
    expect(dist).toBe(MAX_DISTANCE);
    expect(angularDistance(dir, NY)).toBeLessThan(Math.PI / 2);
    expect(angularDistance(dir, far)).toBeLessThan(Math.PI / 2);
  });

  it("uses the same recipe for an exactly antipodal pair without producing NaN", () => {
    const { dir, dist } = solveFraming([NY, latLonToVec3(-40.68, 106.06)], 16 / 9, FOV_DEG, FULL_NDC);
    expect(dist).toBe(MAX_DISTANCE);
    expect(dir.every(Number.isFinite)).toBe(true);
  });
});

describe("createCameraRig in the free area", () => {
  const framed = (aspect: number, rect: NdcRect, points: readonly Vec3[] = LONG_HAUL) => {
    const rig = createCameraRig(aspect);
    rig.setSafeRect(rect, true);
    rig.frame(points, true);
    return rig;
  };

  it("puts a path inside the visible region beside a left column, and the globe centre right of the screen centre", () => {
    const rig = framed(16 / 9, LEFT_COLUMN);
    settle(rig);
    LONG_HAUL.forEach((p) => {
      expect(faces(rig, p)).toBe(true);
      expect(insideRect(ndcOf(rig, p), LEFT_COLUMN)).toBe(true);
    });
    expect(ndcOf(rig, [0, 0, 0]).x).toBeCloseTo(LEFT_COLUMN.cx, 6);
    expect(ndcOf(rig, [0, 0, 0]).x).toBeGreaterThan(0.2);
  });

  it("puts a path inside the band between a top and a bottom sheet at phone width, shifting the centre vertically", () => {
    const rig = framed(PHONE.w / PHONE.h, BAND);
    settle(rig);
    LONG_HAUL.forEach((p) => {
      expect(faces(rig, p)).toBe(true);
      expect(insideRect(ndcOf(rig, p), BAND)).toBe(true);
    });
    expect(ndcOf(rig, [0, 0, 0]).y).toBeCloseTo(BAND.cy, 6);
    expect(BAND.cy).not.toBeCloseTo(0, 1);
  });

  it("tracks the globe's idle rotation, keeping the path in the area", () => {
    const rig = framed(16 / 9, LEFT_COLUMN);
    settle(rig);
    const yaw = 0.4;
    rig.setYaw(yaw);
    settle(rig);
    LONG_HAUL.map((p) => rotateY(p, yaw)).forEach((p) => {
      expect(faces(rig, p)).toBe(true);
      expect(insideRect(ndcOf(rig, p), LEFT_COLUMN)).toBe(true);
    });
  });

  it("re-targets smoothly when the free area changes: no point jumps further than the frame budget", () => {
    const rig = framed(16 / 9, FULL_NDC);
    settle(rig);
    rig.setSafeRect(LEFT_COLUMN, false);
    const screen = (p: Vec3) => {
      const v = ndcOf(rig, p);
      return [((v.x + 1) / 2) * DESKTOP.w, ((1 - v.y) / 2) * DESKTOP.h] as const;
    };
    let prev = LONG_HAUL.map(screen);
    let worst = 0;
    for (let t = 0; t < 6000; t += 1000 / 60) {
      rig.update(1000 / 60);
      const now = LONG_HAUL.map(screen);
      worst = Math.max(worst, ...now.map((q, i) => Math.hypot(q[0] - prev[i]![0], q[1] - prev[i]![1])));
      prev = now;
    }
    expect(worst).toBeLessThan(MAX_JUMP_PX);
    LONG_HAUL.forEach((p) => expect(insideRect(ndcOf(rig, p), LEFT_COLUMN)).toBe(true));
  });

  it("cuts straight to the new area when asked to be instant (reduced motion)", () => {
    const rig = framed(16 / 9, FULL_NDC);
    settle(rig);
    rig.setSafeRect(LEFT_COLUMN, true);
    expect(ndcOf(rig, [0, 0, 0]).x).toBeCloseTo(LEFT_COLUMN.cx, 6);
  });

  it("drops the offset when its scale is 0 (inside the tunnel) and restores it after", () => {
    const rig = framed(16 / 9, LEFT_COLUMN);
    rig.setOffsetScale(0);
    rig.update(16);
    expect(ndcOf(rig, [0, 0, 0]).x).toBeCloseTo(0, 6);
    rig.setOffsetScale(1);
    rig.update(16);
    expect(ndcOf(rig, [0, 0, 0]).x).toBeCloseTo(LEFT_COLUMN.cx, 3);
  });

  it("shifts every point by exactly the offset in NDC, without rescaling the picture", () => {
    const a = createCameraRig(16 / 9);
    a.setSafeRect(FULL_NDC, true);
    a.frame([NY], true);
    const b = createCameraRig(16 / 9);
    b.setSafeRect({ cx: 0.3, cy: -0.2, hx: 1, hy: 1 }, true);
    b.frame([NY], true);
    const probe = latLonToVec3(48, -60);
    const pa = ndcOf(a, probe);
    const pb = ndcOf(b, probe);
    expect(pb.x - pa.x).toBeCloseTo(0.3, 6);
    expect(pb.y - pa.y).toBeCloseTo(-0.2, 6);
  });

  it("keeps the offset through a field-of-view change (the tunnel flight rewrites the projection)", () => {
    const rig = framed(16 / 9, LEFT_COLUMN);
    rig.camera.fov = 50;
    rig.camera.updateProjectionMatrix();
    expect(ndcOf(rig, [0, 0, 0]).x).toBeCloseTo(LEFT_COLUMN.cx, 6);
  });

  it("contains() is true only for points facing the camera and inside the area", () => {
    const rig = framed(16 / 9, LEFT_COLUMN);
    expect(rig.contains(LONG_HAUL)).toBe(true);
    expect(rig.contains([...LONG_HAUL, latLonToVec3(-40, 106)])).toBe(false);
    expect(rig.contains([MOSCOW, latLonToVec3(40.68, -73.94 - 70)])).toBe(false);
  });
});
