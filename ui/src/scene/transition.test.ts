import { describe, expect, it } from "vitest";
import { angularDistance, dot, latLonToVec3, normalize, scale, sub, type Vec3 } from "../geo";
import { FOV_DEG } from "./camera";
import {
  cameraAt, DIVE_MS, easeInOutSine, focusDepth, globeTransition, layerFades, modeOf, rigUp, rotateBetween,
  northUpSafe, REDUCED_MS, reducedShot, S_HOME, startTransition, stepTransition, T_SURFACE, T_SWING, TUNNEL_FOV, viewTOf, type CameraInput, type Transition,
} from "./transition";
import { tunnelFrame, tunnelPoint } from "./tunnelLayout";

const near = (a: Vec3, b: Vec3, digits = 9): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, digits));
const dist = (a: Vec3, b: Vec3): number => Math.hypot(...sub(a, b));
const run = (t: Transition, ms: number, dt = 1000 / 60, durationMs = DIVE_MS): Transition[] => {
  const out: Transition[] = [];
  let cur = t;
  for (let x = 0; x < ms - 1e-9; x += dt) out.push((cur = stepTransition(cur, dt, durationMs)));
  return out;
};

describe("transition timeline", () => {
  it("easeInOutSine pins the ends and the midpoint", () => {
    expect(easeInOutSine(0)).toBe(0);
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOutSine(1)).toBe(1);
  });

  it("dive runs viewT 0→1 monotonically over DIVE_MS, then settles in the tunnel", () => {
    const frames = run(startTransition(globeTransition, 1), DIVE_MS);
    const vs = frames.map(viewTOf);
    vs.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(vs[i]!));
    expect(vs[vs.length - 1]).toBeCloseTo(1, 9);
    expect(modeOf(frames[0]!)).toBe("diving");
    expect(modeOf(frames[frames.length - 1]!)).toBe("tunnel");
  });

  it("surface replays the dive's viewT curve in reverse", () => {
    const dive = run(startTransition(globeTransition, 1), DIVE_MS, 100).map(viewTOf);
    const tunnel = run(startTransition(globeTransition, 1), DIVE_MS + 100).pop()!;
    const surf = run(startTransition(tunnel, 0), DIVE_MS, 100).map(viewTOf);
    surf.forEach((v, i) => expect(v).toBeCloseTo(i + 1 < dive.length ? dive[dive.length - 2 - i]! : 0, 9));
    expect(modeOf(run(startTransition(tunnel, 0), DIVE_MS + 100).pop()!)).toBe("globe");
  });

  it("reversing mid-dive continues from the current viewT (no jump)", () => {
    const mid = run(startTransition(globeTransition, 1), 1000).pop()!;
    const back = stepTransition(startTransition(mid, 0), 1000 / 60);
    const fwd = stepTransition(mid, 1000 / 60);
    // One frame back moves exactly as far as one frame forward would have.
    expect(Math.abs(viewTOf(back) - viewTOf(mid))).toBeLessThanOrEqual(Math.abs(viewTOf(fwd) - viewTOf(mid)) * 1.01);
    expect(modeOf(back)).toBe("surfacing");
  });

  it("reduced motion cuts straight to the target's resting shot; the whole change runs within REDUCED_MS", () => {
    expect(reducedShot(globeTransition)).toBe("globe");
    const dive = run(startTransition(globeTransition, 1), REDUCED_MS, 1000 / 60, REDUCED_MS);
    expect(dive.every((t) => reducedShot(t) === "tunnel")).toBe(true);
    expect(modeOf(dive[dive.length - 1]!)).toBe("tunnel");
    const back = run(startTransition(dive[dive.length - 1]!, 0), REDUCED_MS, 1000 / 60, REDUCED_MS);
    expect(back.every((t) => reducedShot(t) === "globe")).toBe(true);
    expect(modeOf(back[back.length - 1]!)).toBe("globe");
  });

  it("starting toward the current target is a no-op", () => {
    expect(startTransition(globeTransition, 0)).toBe(globeTransition);
  });
});

describe("rotateBetween", () => {
  it("maps a onto b and preserves vectors on the rotation axis", () => {
    const a = normalize([1, 0.2, 0]);
    const b = normalize([0, 0.3, 1]);
    near(rotateBetween(a, b, a), b, 12);
    const axis = normalize([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
    near(rotateBetween(a, b, axis), axis, 12);
  });
  it("is the identity when a = b", () => {
    near(rotateBetween([0, 0, 1], [0, 0, 1], [1, 2, 3]), [1, 2, 3], 12);
  });
});

describe("cameraAt", () => {
  const origin = latLonToVec3(40.68, -73.94);
  const rigPos: Vec3 = scale(normalize([0.2, 0.6, 0.8]), 3.4);
  const f0 = normalize(scale(rigPos, -1));
  const frame = tunnelFrame(origin, rotateBetween(f0, scale(origin, -1), rigUp(f0)));
  const input: CameraInput = { rigPos, orbitR: 3.4, frame, camS: S_HOME, northUp: false };

  it("starts exactly at the globe rig pose", () => {
    const c = cameraAt(0, input);
    near(c.pos, rigPos);
    near(c.look, [0, 0, 0]);
    near(c.up, rigUp(f0));
    expect(c.fovDeg).toBe(FOV_DEG);
  });

  it("ends a short way down the tunnel, looking along it", () => {
    const c = cameraAt(1, input);
    near(c.pos, tunnelPoint(frame, S_HOME));
    expect(dot(normalize(sub(c.look, c.pos)), frame.n)).toBeGreaterThan(0.99);
    expect(c.fovDeg).toBe(TUNNEL_FOV);
  });

  it("passes through the origin node when it crosses the surface", () => {
    near(cameraAt(T_SURFACE, input).pos, origin);
  });

  // Rig 75° away from the origin and further out: the longest swing the globe rig can produce for a framed route.
  const farRig: Vec3 = scale(latLonToVec3(10, -150), 4.5);
  const farFrame = tunnelFrame(origin, rotateBetween(normalize(scale(farRig, -1)), scale(origin, -1), rigUp(normalize(scale(farRig, -1)))));
  it.each([["near rig", input], ["far rig", { rigPos: farRig, orbitR: 3.4, frame: farFrame, camS: S_HOME, northUp: false }]] as const)(
    "is continuous (%s): 1/600 viewT steps move position, view direction and roll by small bounded amounts", (_, inp) => {
    const poses = Array.from({ length: 601 }, (_, i) => cameraAt(i / 600, inp));
    const steps = poses.slice(1).map((c, i) => {
      const p = poses[i]!;
      const fwd = (x: typeof c): Vec3 => normalize(sub(x.look, x.pos));
      return { pos: dist(c.pos, p.pos), dir: angularDistance(fwd(c), fwd(p)), up: angularDistance(c.up, p.up), fov: Math.abs(c.fovDeg - p.fovDeg) };
    });
    // No single step may spike: the eased Catmull-Rom's peak speed stays within 4× its mean.
    const mean = steps.reduce((a, s) => a + s.pos, 0) / steps.length;
    expect(Math.max(...steps.map((s) => s.pos))).toBeLessThan(4 * mean);
    expect(Math.max(...steps.map((s) => s.dir))).toBeLessThan((1.5 * Math.PI) / 180);
    expect(Math.max(...steps.map((s) => s.up))).toBeLessThan((1.5 * Math.PI) / 180);
    expect(Math.max(...steps.map((s) => s.fov))).toBeLessThan(0.5);
  });

  it("keeps the camera outside the globe until the surface crossing", () => {
    for (const inp of [input, { rigPos: farRig, orbitR: 3.4, frame: farFrame, camS: S_HOME, northUp: false }]) {
      for (let i = 0; i < 100; i++) {
        const v = (i / 100) * T_SURFACE;
        expect(Math.hypot(...cameraAt(v, inp).pos)).toBeGreaterThan(0.999);
      }
    }
  });

  it("follows the helix to a focused gate once in the tunnel", () => {
    const c = cameraAt(1, { ...input, camS: focusDepth(4.2) });
    near(c.pos, tunnelPoint(frame, focusDepth(4.2)));
  });
});

describe("north-up roll", () => {
  const origin = latLonToVec3(40.68, -73.94);
  const n = scale(origin, -1);
  const overAsia: Vec3 = scale(latLonToVec3(45, 100), 3.4);

  it("is safe for a mid-latitude origin, but not near a pole or when the swing crosses one", () => {
    expect(northUpSafe(overAsia, origin)).toBe(true);
    expect(northUpSafe(overAsia, latLonToVec3(80, 15))).toBe(false);
    expect(northUpSafe(scale(latLonToVec3(85, 0), 3.4), origin)).toBe(false);
  });

  it("swings around the globe rather than over a pole, even to the far side", () => {
    const from = scale(latLonToVec3(48, 100), 3.4);
    const to = latLonToVec3(48, -80);
    const input: CameraInput = { rigPos: from, orbitR: 3.4, frame: tunnelFrame(to, [0, 1, 0]), camS: S_HOME, northUp: true };
    const path = Array.from({ length: 101 }, (_, i) => cameraAt((i / 100) * T_SWING, input).pos);
    expect(Math.max(...path.map((p) => Math.abs(normalize(p)[1])))).toBeLessThan(0.9);
    expect(Math.min(...path.map((p) => Math.hypot(...p)))).toBeGreaterThan(2.5);
  });

  it("keeps the globe's north up over the origin, however far the rig swung to get there", () => {
    const frame = tunnelFrame(origin, [0, 1, 0]);
    const input: CameraInput = { rigPos: overAsia, orbitR: 3.4, frame, camS: S_HOME, northUp: true };
    const north = rigUp(n);
    for (const v of [T_SWING, 0.6, T_SURFACE, 1]) {
      expect(dot(cameraAt(v, input).up, north)).toBeGreaterThan(0.98);
    }
    const steps = Array.from({ length: 601 }, (_, i) => cameraAt(i / 600, input).up);
    expect(Math.max(...steps.slice(1).map((u, i) => angularDistance(u, steps[i]!)))).toBeLessThan((1.5 * Math.PI) / 180);
  });
});

describe("layerFades", () => {
  it("globe fully on at viewT 0, tunnel fully on at viewT 1", () => {
    const g = layerFades(0);
    expect([g.surface, g.dots, g.atmosphere, g.arcs, g.tunnel, g.gates, g.labels]).toEqual([1, 1, 1, 1, 0, 0, 0]);
    const t = layerFades(1);
    expect([t.surface, t.dots, t.atmosphere, t.arcs, t.tunnel, t.gates, t.labels]).toEqual([0, 0, 0, 0, 1, 1, 1]);
  });
  it("globe is gone by the time the camera crosses the surface", () => {
    expect(layerFades(T_SURFACE).surface).toBe(0);
  });
});
