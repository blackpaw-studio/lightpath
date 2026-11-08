import { describe, expect, it } from "vitest";
import { angularDistance, latLonToVec3, type Vec3 } from "../geo";
import type { GlobeLayout } from "./layout";
import {
  appearance, APPEAR_MS, createGlobePoseSource, emptyPoseState, GLIDE_MAX_RAD_PER_S, ORIGIN_KEY, stepGlobePoses, type PoseInput,
} from "./globePoses";

const layout = (hops: [number, Vec3][], generation = 1): GlobeLayout => ({
  generation,
  origin: latLonToVec3(0, 0),
  hops: hops.map(([ttl, pos]) => ({ ttl, pos, estimated: false, timeout: false, rttMs: 5, color: "#22e6ff" })),
});
const input = (l: GlobeLayout, nowMs: number, dtMs = 16, extra: Partial<PoseInput> = {}): PoseInput =>
  ({ layout: l, nowMs, dtMs, reducedMotion: false, rotationY: 0, ...extra });

describe("appearance", () => {
  it("pops scale from 0 past 1 and settles at 1 (ease-out-back) at full opacity", () => {
    expect(appearance(0, false).scale).toBe(0);
    const peak = Math.max(...Array.from({ length: 41 }, (_, i) => appearance((i / 40) * APPEAR_MS, false).scale));
    expect(peak).toBeGreaterThan(1);
    expect(appearance(APPEAR_MS, false)).toEqual({ scale: 1, opacity: 1 });
    expect(appearance(APPEAR_MS * 5, false)).toEqual({ scale: 1, opacity: 1 });
  });

  it("fades opacity at full scale under reduced motion", () => {
    expect(appearance(0, true)).toEqual({ scale: 1, opacity: 0 });
    expect(appearance(APPEAR_MS / 2, true).opacity).toBeCloseTo(0.5, 6);
    expect(appearance(APPEAR_MS, true)).toEqual({ scale: 1, opacity: 1 });
  });
});

describe("stepGlobePoses", () => {
  const a = latLonToVec3(10, 10);
  const b = latLonToVec3(10, 60);

  it("emits the origin and each hop, born at their first frame", () => {
    const { poses } = stepGlobePoses(emptyPoseState, input(layout([[1, a]]), 1000));
    expect([...poses.keys()]).toEqual([ORIGIN_KEY, 1]);
    expect(poses.get(1)!.scale).toBe(0);
    const later = stepGlobePoses(stepGlobePoses(emptyPoseState, input(layout([[1, a]]), 1000)).state,
      input(layout([[1, a]]), 1000 + APPEAR_MS));
    expect(later.poses.get(1)!.scale).toBe(1);
  });

  it("glides a relocated hop instead of teleporting, and converges", () => {
    let s = stepGlobePoses(emptyPoseState, input(layout([[1, a]]), 0)).state;
    let prev: Vec3 = a;
    let maxStep = 0;
    for (let t = 16; t <= 3000; t += 16) {
      const r = stepGlobePoses(s, input(layout([[1, b]]), t));
      const pos = r.poses.get(1)!.pos;
      maxStep = Math.max(maxStep, angularDistance(prev, pos));
      prev = pos;
      s = r.state;
    }
    expect(maxStep).toBeLessThan(angularDistance(a, b) * 0.1);
    expect(angularDistance(prev, b)).toBeLessThan(1e-4);
  });

  it("caps glide speed on a cross-globe relocation (hop.update moving a hop 108°), then still converges", () => {
    const far = latLonToVec3(10, 118);
    let s = stepGlobePoses(emptyPoseState, input(layout([[1, a]]), 0)).state;
    let prev: Vec3 = a;
    let maxStep = 0;
    for (let t = 16; t <= 4000; t += 16) {
      const r = stepGlobePoses(s, input(layout([[1, far]]), t));
      const pos = r.poses.get(1)!.pos;
      maxStep = Math.max(maxStep, angularDistance(prev, pos));
      prev = pos;
      s = r.state;
    }
    expect(maxStep).toBeLessThanOrEqual(GLIDE_MAX_RAD_PER_S * 0.016 + 1e-9);
    expect(angularDistance(prev, far)).toBeLessThan(1e-4);
  });

  it("does not move anything when dt is 0", () => {
    const s = stepGlobePoses(emptyPoseState, input(layout([[1, a]]), 0)).state;
    expect(stepGlobePoses(s, input(layout([[1, b]]), 0, 0)).poses.get(1)!.pos).toEqual(a);
  });

  it("drops hops no longer in the layout (new trace)", () => {
    const s = stepGlobePoses(emptyPoseState, input(layout([[1, a]]), 0)).state;
    expect([...stepGlobePoses(s, input(layout([]), 16)).poses.keys()]).toEqual([ORIGIN_KEY]);
  });

  it("emits no origin pose when the layout has none", () => {
    const { poses } = stepGlobePoses(emptyPoseState, input({ generation: 0, origin: null, hops: [] }, 0));
    expect(poses.size).toBe(0);
  });

  it("restarts hops on a new trace generation, even in the same frame as hop 1", () => {
    const a1 = stepGlobePoses(emptyPoseState, input(layout([[1, a]], 1), 0)).state;
    const settled = stepGlobePoses(a1, input(layout([[1, a]], 1), 5000)).state;
    const next = stepGlobePoses(settled, input(layout([[1, b]], 2), 5016));
    expect(next.poses.get(1)).toMatchObject({ pos: b, scale: 0 }); // blooms in at its own spot, no glide
    expect(next.poses.get(ORIGIN_KEY)!.scale).toBe(1); // the user's origin carries over
  });

  it("keeps the previous origin when a new trace has none yet", () => {
    const s = stepGlobePoses(emptyPoseState, input(layout([], 1), 0)).state;
    const { poses } = stepGlobePoses(s, input({ generation: 2, origin: null, hops: [] }, 5000));
    expect(poses.get(ORIGIN_KEY)).toMatchObject({ pos: latLonToVec3(0, 0), scale: 1, opacity: 1 });
  });

  it("applies the globe rotation to world positions", () => {
    const { poses } = stepGlobePoses(emptyPoseState, input(layout([]), 0, 16, { rotationY: Math.PI / 2 }));
    const p = poses.get(ORIGIN_KEY)!.pos; // (1,0,0) rotated +90° about y → (0,0,-1)
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[2]).toBeCloseTo(-1, 12);
  });
});

describe("createGlobePoseSource", () => {
  const a = latLonToVec3(10, 10);
  const b = latLonToVec3(10, 60);
  const frames = [0, 16, 32, 48].map((t, i) => input(layout(i < 2 ? [[1, a]] : [[1, b]]), t));

  it("produces the same poses as stepping the pure function", () => {
    const source = createGlobePoseSource();
    let s = emptyPoseState;
    for (const f of frames) {
      const r = stepGlobePoses(s, f);
      s = r.state;
      expect([...source(f)]).toEqual([...r.poses]);
    }
  });

  it("double-buffers its maps: the previous frame's map stays intact, then is reused", () => {
    const source = createGlobePoseSource();
    const m0 = source(frames[0]!);
    const snapshot = [...m0];
    const m1 = source(frames[1]!);
    expect(m1).not.toBe(m0);
    expect([...m0]).toEqual(snapshot);
    expect(source(frames[2]!)).toBe(m0);
  });
});
