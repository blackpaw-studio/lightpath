import { describe, expect, it } from "vitest";
import { Group, Texture } from "three";
import { GLIDE_MAX_RAD_PER_S, emptyPoseState, stepGlobePoses, type GlobePoseState, type PoseMap } from "./globePoses";
import type { Hop, Origin } from "../protocol";
import { initialState, type TraceState } from "../reducer";
import { createArcs } from "./arcs";
import { arcInfos } from "./globe";
import { runAnchors, stepArcShapes, targetShapes, SHAPE_TAU_MS } from "./arcShape";
import type { LaidHop } from "./layout";
import { slerpGreatCircle, type Vec3 } from "../geo";
import { globeLayout } from "./layout";

const FRAME_MS = 1000 / 60;
/** One frame's glide at top speed, times the 1.1 margin and the arc's extra reach over the surface (as in the E2E bound). */
const CREST_BUDGET = ((GLIDE_MAX_RAD_PER_S * FRAME_MS) / 1000) * 1.1 * 1.8;

const origin: Origin = { publicIp: "1.2.3.4", lat: 40.7, lon: -74, city: "NYC", asn: 1, org: "x" };
const hopAt = (ttl: number, at: [number, number] | null, rttMs: number): Hop => ({
  ttl, probes: [{ ip: at ? "8.8.8.8" : null, rttMs: at ? rttMs : null }], ip: at ? "8.8.8.8" : null, host: null, asn: null, org: null,
  lat: at?.[0] ?? null, lon: at?.[1] ?? null, city: null, geoSource: at ? "api" : "estimated", annotations: [],
});
const stateOf = (hops: Hop[]): TraceState => ({ ...initialState, status: "done", origin, hops, reached: true, endReason: "reached" });

// Four hops, the middle two estimated between London and Moscow.
const RUN = [hopAt(1, [51.5, -0.1], 70), hopAt(2, null, 0), hopAt(3, null, 0), hopAt(4, [55.75, 37.6], 120)];
// The same trace after hop 3 gets a location of its own, far off the run's great circle.
const SPLIT = [RUN[0]!, RUN[1]!, hopAt(3, [25, 55], 100), RUN[3]!];

/** Drives pose source → arcs frame by frame; returns each arc's crest (world position) per frame, keyed by ttl. */
const play = (script: readonly TraceState[], reducedMotion = false): Map<number, number[][]>[] => {
  const arcs = createArcs(new Group(), () => new Texture());
  let state: GlobePoseState = emptyPoseState;
  const frames: Map<number, number[][]>[] = [];
  script.forEach((s, i) => {
    const layout = globeLayout(s);
    const stepped = stepGlobePoses(state, { layout, nowMs: i * FRAME_MS, dtMs: FRAME_MS, reducedMotion, rotationY: 0 });
    state = stepped.state;
    const poses: PoseMap = stepped.poses;
    arcs.update(poses, arcInfos(layout), i * FRAME_MS, reducedMotion, layout.generation);
    frames.push(new Map([...arcs.crests()].map(([ttl, m]) => [ttl, [[...m.pos]]])));
  });
  return frames;
};

const maxCrestStep = (frames: readonly Map<number, number[][]>[]): number =>
  frames.slice(1).reduce((worst, f, i) => [...f].reduce((w, [ttl, [p]]) => {
    const q = frames[i]!.get(ttl)?.[0];
    return q ? Math.max(w, Math.hypot(p![0]! - q[0]!, p![1]! - q[1]!, p![2]! - q[2]!)) : w;
  }, worst), 0);

describe("arc shape across a run split", () => {
  it("steps no arc's crest by more than the motion budget while a hop mid-run gets located and glides away", () => {
    const script = [...Array(30).fill(stateOf(RUN)), ...Array(150).fill(stateOf(SPLIT))] as TraceState[];
    const step = maxCrestStep(play(script));
    expect(step).toBeLessThanOrEqual(CREST_BUDGET);
  });

  it("takes the split as a cut under reduced motion: no easing, the change flagged on that frame only", () => {
    const layouts = [...Array(3).fill(RUN), ...Array(3).fill(SPLIT)].map((h) => globeLayout(stateOf(h)));
    let state: GlobePoseState = emptyPoseState;
    const snapped = layouts.map((layout, i) => {
      const r = stepGlobePoses(state, { layout, nowMs: i * FRAME_MS, dtMs: FRAME_MS, reducedMotion: true, rotationY: 0 });
      state = r.state;
      return [...r.poses.values()].some((p) => p.arcIn?.snapped === true);
    });
    expect(snapped).toEqual([false, false, false, true, false, false]);
  });

  it("restarts clean on a new trace generation", () => {
    const a = stepGlobePoses(emptyPoseState, { layout: globeLayout(stateOf(RUN)), nowMs: 0, dtMs: FRAME_MS, reducedMotion: false, rotationY: 0 });
    const split = stepGlobePoses(a.state, { layout: globeLayout(stateOf(SPLIT)), nowMs: FRAME_MS, dtMs: FRAME_MS, reducedMotion: false, rotationY: 0 });
    expect(split.state.arcShapes.get(3)!.offset.theta).not.toBe(0); // easing a split
    const next = stepGlobePoses(split.state, { layout: globeLayout({ ...stateOf(SPLIT), generation: 2 }), nowMs: 2 * FRAME_MS, dtMs: FRAME_MS, reducedMotion: false, rotationY: 0 });
    expect([...next.state.arcShapes.values()].every((e) => e.offset.theta === 0 && e.offset.t0 === 0)).toBe(true);
  });
});

describe("stepArcShapes", () => {
  const laid = (ttl: number, located: boolean): LaidHop =>
    ({ ttl, pos: [1, 0, 0], estimated: !located, located, timeout: false, rttMs: null, color: "#fff" });
  const A: Vec3 = [1, 0, 0];
  const B: Vec3 = [0, 1, 0];
  const run = [laid(1, true), laid(2, false), laid(3, true)];
  const at = (t: number): Map<number, Vec3> =>
    new Map([[0, A], [1, A], [2, slerpGreatCircle(A, B, t)], [3, B]]);

  it("finds each run's anchors; a split or a merge changes them", () => {
    expect(runAnchors(run).get(1)).toEqual({ from: 1, to: 3 });
    expect(runAnchors([laid(1, true), laid(2, true), laid(3, true)]).size).toBe(0);
    expect(runAnchors([laid(1, false), laid(2, false), laid(3, true)]).size).toBe(0);
  });

  it("follows a moving target exactly while the run's structure is unchanged (no lag behind the nodes)", () => {
    let prev = stepArcShapes(new Map(), targetShapes(run, at(0.2), 0), 16, false).state;
    for (const t of [0.3, 0.4, 0.5]) {
      const r = stepArcShapes(prev, targetShapes(run, at(t), 0), 16, false);
      expect(r.shapes.get(2)!.t1).toBeCloseTo(t, 6);
      prev = r.state;
    }
  });

  it("eases a structure change over the glide time constant", () => {
    const before = stepArcShapes(new Map(), targetShapes(run, at(0.5), 0), 16, false).state;
    const merged = [laid(1, true), laid(2, true), laid(3, true)];
    const first = stepArcShapes(before, targetShapes(merged, at(0.5), 0), 16, false);
    expect(first.shapes.get(2)!.theta).toBeGreaterThan(0.9 * Math.PI / 2 * 0.5); // starts from the run's hump parameters
    const later = stepArcShapes(first.state, targetShapes(merged, at(0.5), 0), SHAPE_TAU_MS, false);
    expect(Math.abs(later.state.get(2)!.offset.theta)).toBeLessThan(Math.abs(first.state.get(2)!.offset.theta) * Math.exp(-1) * 1.01);
  });
});
