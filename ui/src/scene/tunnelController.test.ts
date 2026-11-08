// Unit-level motion check (plan §G): drive the real pose source, transition and
// camera curve frame by frame, project every hop through the resulting camera,
// and require checkTrace to find no jumps, world teleports or flicker.
import { describe, expect, it } from "vitest";
import { Group, Matrix4, Object3D, PerspectiveCamera, Texture, Vector3 } from "three";
import { sampleTimeline } from "../../dev/sample";
import { checkTrace, type Frame, type TraceOptions } from "../invariants";
import { initialState, reduce, type TraceState } from "../reducer";
import { VISIBLE_OPACITY } from "../testhooks";
import { normalize, sub, type Vec3 } from "../geo";
import { createCameraRig } from "./camera";
import { createGates } from "./gates";
import { createGlobePoseSource, ORIGIN_KEY } from "./globePoses";
import type { GateLabelView } from "./labels";
import { markEntities } from "./marks";
import { createNodes, type NodeInfo } from "./nodes";
import { globeLayout } from "./layout";
import { DIVE_MS, S_HOME, focusDepth, type CameraPose, type LayerFades } from "./transition";
import { smoothstep } from "./easing";
import { createTunnelController, type TunnelController } from "./tunnelController";
import { FLICKER_WINDOW_MS, MAX_JUMP_PX, worldJumpBound } from "./motionBudget";
import { MIN_GAP, tunnelPoint } from "./tunnelLayout";

const DT = 1000 / 60;
const doneState: TraceState = sampleTimeline.reduce((s, [, m]) => reduce(s, m), initialState);

interface Sim {
  readonly ctl: TunnelController;
  run(ms: number): Frame[];
  /** A new reducer state (e.g. a new trace generation) for both the controller and the pose source. */
  setState(state: TraceState): void;
  /** Camera position of every frame run so far. */
  readonly camTrail: Vec3[];
}

const stepLen = (trail: readonly Vec3[]): number[] =>
  trail.slice(1).map((p, i) => Math.hypot(p[0] - trail[i]![0], p[1] - trail[i]![1], p[2] - trail[i]![2]));

/** Gate labels without a DOM: the simulation traces their drawn position and opacity only. */
const stubLabel = (): GateLabelView => ({ object: new Object3D(), set: () => {}, setSide: () => {}, setOpacity: () => {}, dispose: () => {} });

const nodeLook = (layout: ReturnType<typeof globeLayout>): Map<number, NodeInfo> => new Map([
  [ORIGIN_KEY, { color: "#e8fbff", estimated: false, timeout: false, role: "origin" }],
  ...layout.hops.map((h): [number, NodeInfo] => [h.ttl, { color: h.color, estimated: h.estimated, timeout: h.timeout, role: "hop" }]),
]);

interface SimOptions {
  /** Replace the controller's layer fades (to prove the trace sees a broken handoff). */
  readonly fades?: (f: LayerFades, viewT: number) => LayerFades;
}

const createSim = (w: number, h: number, reducedMotion: boolean, state: TraceState = doneState, opts: SimOptions = {}): Sim => {
  let layout = globeLayout(state);
  let traceState = state;
  const camTrail: Vec3[] = [];
  // The real node and gate renderers, so the trace sees their drawn alpha (dot size, ring fade × fog, label rank).
  const scene = new Group();
  const nodes = createNodes(scene, () => new Texture());
  const gates = createGates(scene, stubLabel);
  const rig = createCameraRig(w / h);
  if (layout.origin) rig.frame([layout.origin, ...layout.hops.map((x) => x.pos)], true);
  const rigPos: Vec3 = [rig.camera.position.x, rig.camera.position.y, rig.camera.position.z];
  const ctl = createTunnelController({ globeSource: createGlobePoseSource(), rigPos: () => rigPos, aspect: () => w / h, reducedMotion });
  ctl.setState(state);
  const cam = new PerspectiveCamera(35, w / h, 0.01, 100);
  const m = new Matrix4();
  const place = (c: CameraPose): void => {
    cam.fov = c.fovDeg;
    cam.updateProjectionMatrix();
    cam.position.set(...c.pos);
    cam.quaternion.setFromRotationMatrix(m.lookAt(new Vector3(...c.pos), new Vector3(...c.look), new Vector3(...c.up)));
    cam.updateMatrixWorld(true);
  };
  let now = 0;
  const frame = (): Frame => {
    now += DT;
    ctl.advance(DT);
    const poses = ctl.poseSource({ layout, nowMs: now, dtMs: DT, reducedMotion, rotationY: 0 });
    const pose = ctl.camera();
    camTrail.push(pose.pos);
    place(pose);
    const project = (p: readonly [number, number, number]): { x: number; y: number; inFrustum: boolean } => {
      const v = new Vector3(...p).project(cam);
      const inFrustum = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z >= -1 && v.z <= 1;
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, inFrustum };
    };
    const f = opts.fades ? opts.fades(ctl.fades(), ctl.viewT()) : ctl.fades();
    nodes.update(poses, nodeLook(layout), now, reducedMotion, layout.generation);
    gates.update({
      poses, gates: ctl.gates(), depths: ctl.depths(), frame: ctl.frame(), cameraPos: pose.pos,
      cameraFwd: normalize(sub(pose.look, pose.pos)), generation: traceState.generation,
      ringFade: f.gates, labelFade: f.labels, nowMs: now, reducedMotion, aspect: w / h, dtMs: DT, project,
    });
    const entities = {
      ...Object.fromEntries([...poses].map(([k, p]) => {
        const s = project(p.pos);
        return [String(k), { x: s.x, y: s.y, world: p.pos, visible: p.opacity > VISIBLE_OPACITY && s.inFrustum }];
      })),
      ...markEntities(nodes.marks(), gates.marks(), project),
    };
    return { tMs: now, cut: ctl.cut(), entities };
  };
  return {
    ctl, camTrail,
    run: (ms) => Array.from({ length: Math.round(ms / DT) }, frame),
    setState: (s) => {
      traceState = s;
      layout = globeLayout(s, layout.origin);
      ctl.setState(s);
    },
  };
};

/** Trace options with the world bound measured on this simulation's own globe and tunnel frames. */
const optsFor = (frames: readonly Frame[], globeAt: number, tunnelAt: number): TraceOptions => {
  const maxJumpWorld = worldJumpBound(frames[globeAt]!, frames[tunnelAt]!);
  // A gate re-laid out by one MIN_GAP must still exceed the bound, or the world check could not see it.
  expect(maxJumpWorld).toBeLessThan(MIN_GAP);
  return { maxJumpPx: MAX_JUMP_PX, flickerWindowMs: FLICKER_WINDOW_MS, maxJumpWorld };
};

describe.each([[1280, 720], [375, 812]])("dive and surface at %ix%i", (w, h) => {
  it("full motion: no screen jumps, world teleports or flicker; ends where it started", () => {
    const sim = createSim(w, h, false);
    const frames = sim.run(1000);
    expect(sim.ctl.dive()).toBe(true);
    frames.push(...sim.run(DIVE_MS + 500));
    const inTunnel = frames.length - 1;
    expect(sim.ctl.mode()).toBe("tunnel");
    sim.ctl.surface();
    frames.push(...sim.run(DIVE_MS + 500));
    expect(sim.ctl.mode()).toBe("globe");
    expect(checkTrace(frames, optsFor(frames, 59, inTunnel))).toEqual([]);
    const [first, last] = [frames[59]!, frames[frames.length - 1]!];
    Object.entries(first.entities).forEach(([k, e]) => {
      const f = last.entities[k]!;
      expect(f.visible).toBe(e.visible);
      expect(Math.hypot(f.x - e.x, f.y - e.y)).toBeLessThan(1e-6);
    });
  });

  it("traces every drawn hop marker and label, and a dot→ring handoff gap shows up as flicker", () => {
    const run = (sim: Sim): Frame[] => {
      const frames = sim.run(1000);
      sim.ctl.dive();
      frames.push(...sim.run(DIVE_MS + 500));
      return frames;
    };
    const frames = run(createSim(w, h, false));
    const ids = Object.keys(frames[frames.length - 1]!.entities);
    expect(ids.filter((k) => k.startsWith("g:"))).toHaveLength(13);
    expect(ids.filter((k) => k.startsWith("l:"))).toHaveLength(12);
    // Rings that only fade in after the dots have shrunk away leave every hop undrawn for a moment.
    const late = createSim(w, h, false, doneState, { fades: (f, viewT) => ({ ...f, gates: smoothstep(0.92, 1, viewT) }) });
    const gaps = checkTrace(run(late), { maxJumpPx: MAX_JUMP_PX, flickerWindowMs: FLICKER_WINDOW_MS })
      .filter((v) => v.kind === "flicker" && v.id.startsWith("g:"));
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("focus a deep gate, then surface from there", () => {
    const sim = createSim(w, h, false);
    const frames = sim.run(100);
    sim.ctl.dive();
    frames.push(...sim.run(DIVE_MS + 300));
    const inTunnel = frames.length - 1;
    expect(sim.ctl.focusHop(12)).toBe(true);
    frames.push(...sim.run(4000));
    const cam = sim.ctl.camera().pos;
    const want = tunnelPoint(sim.ctl.frame()!, focusDepth(sim.ctl.depths().get(12)!));
    cam.forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 3));
    sim.ctl.surface();
    frames.push(...sim.run(DIVE_MS + 2500));
    expect(sim.ctl.mode()).toBe("globe");
    expect(checkTrace(frames, optsFor(frames, 0, inTunnel))).toEqual([]);
  });

  it("reduced motion: cuts only into and out of the overhead shot, poses still continuous in world space", () => {
    const sim = createSim(w, h, true);
    const frames = sim.run(200);
    sim.ctl.dive();
    // Dwell past the flicker window: the cut into the tunnel hides the mouth
    // behind the camera, and surfacing cuts back to a shot that shows it, so a
    // user reversing within the window does (correctly) see it re-appear.
    frames.push(...sim.run(DIVE_MS + FLICKER_WINDOW_MS + 300));
    const inTunnel = frames.length - 1;
    expect(sim.ctl.mode()).toBe("tunnel");
    sim.ctl.surface();
    frames.push(...sim.run(DIVE_MS + 300));
    expect(frames.filter((f) => f.cut)).toHaveLength(4);
    expect(checkTrace(frames, optsFor(frames, 0, inTunnel))).toEqual([]);
  });
});

describe("tunnel controller", () => {
  it("cannot dive before there is an origin", () => {
    const sim = createSim(1280, 720, false, { ...doneState, origin: null, hops: [] });
    expect(sim.ctl.dive()).toBe(false);
    expect(sim.ctl.mode()).toBe("globe");
  });

  it("anchors the tunnel at the origin node and settles the camera at home depth", () => {
    const sim = createSim(1280, 720, false);
    const before = sim.run(10).pop()!.entities[String(ORIGIN_KEY)]!.world!;
    sim.ctl.dive();
    sim.run(DIVE_MS + 100);
    sim.ctl.frame()!.origin.forEach((x, i) => expect(x).toBeCloseTo(before[i]!, 12));
    const home = tunnelPoint(sim.ctl.frame()!, S_HOME);
    sim.ctl.camera().pos.forEach((x, i) => expect(x).toBeCloseTo(home[i]!, 9));
  });

  it("a new trace started deep in the tunnel glides the camera home like a focus on the mouth, no teleport", () => {
    const deep = (): { sim: Sim; from: number } => {
      const sim = createSim(1280, 720, false);
      sim.run(100);
      sim.ctl.dive();
      sim.run(DIVE_MS + 300);
      sim.ctl.focusHop(12);
      sim.run(4000);
      return { sim, from: sim.camTrail.length - 1 };
    };
    const restarted = sampleTimeline.reduce((s, [, m]) => reduce(s, m), doneState);
    expect(restarted.generation).toBe(doneState.generation + 1);
    const a = deep();
    a.sim.setState(restarted);
    a.sim.run(4000);
    const home = tunnelPoint(a.sim.ctl.frame()!, S_HOME);
    a.sim.ctl.camera().pos.forEach((x, i) => expect(x).toBeCloseTo(home[i]!, 3));
    const b = deep();
    b.sim.ctl.focusHop(ORIGIN_KEY);
    b.sim.run(4000);
    const peak = (x: { sim: Sim; from: number }): number => Math.max(...stepLen(x.sim.camTrail.slice(x.from)));
    expect(peak(a)).toBeLessThanOrEqual(peak(b) * 1.0001);
  });

  it("focusing a deep gate early in a dive moves the camera no faster than diving, then focusing", () => {
    const peak = (focusAfterMs: number): number => {
      const sim = createSim(1280, 720, false);
      sim.run(100);
      sim.ctl.dive();
      sim.run(focusAfterMs);
      expect(sim.ctl.focusHop(12)).toBe(true);
      sim.run(DIVE_MS + 4000);
      return Math.max(...stepLen(sim.camTrail));
    };
    // The spring starts while the surface entry is still decelerating, so the
    // two briefly add; the strobe this guards against was 2.2x.
    expect(peak(200)).toBeLessThanOrEqual(peak(DIVE_MS + 300) * 1.1);
  });

  it("focusHop outside the tunnel is declined (the globe view owns it)", () => {
    const sim = createSim(1280, 720, false);
    sim.run(10);
    expect(sim.ctl.focusHop(3)).toBe(false);
  });
});
