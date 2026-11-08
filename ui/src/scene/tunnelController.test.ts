// Unit-level motion check (plan §G): drive the real pose source, transition and
// camera curve frame by frame, project every hop through the resulting camera,
// and require checkTrace to find no jumps, world teleports or flicker.
import { describe, expect, it } from "vitest";
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { sampleTimeline } from "../../dev/sample";
import { checkTrace, type Frame, type TraceOptions } from "../invariants";
import { initialState, reduce, type TraceState } from "../reducer";
import { VISIBLE_OPACITY } from "../testhooks";
import type { Vec3 } from "../geo";
import { createCameraRig } from "./camera";
import { createGlobePoseSource, ORIGIN_KEY } from "./globePoses";
import { globeLayout } from "./layout";
import { DIVE_MS, S_HOME, focusDepth, type CameraPose } from "./transition";
import { createTunnelController, type TunnelController } from "./tunnelController";
import { FLICKER_WINDOW_MS, MAX_JUMP_PX, worldJumpBound } from "./motionBudget";
import { MIN_GAP, tunnelPoint } from "./tunnelLayout";

const DT = 1000 / 60;
const doneState: TraceState = sampleTimeline.reduce((s, [, m]) => reduce(s, m), initialState);

interface Sim {
  readonly ctl: TunnelController;
  run(ms: number): Frame[];
}

const createSim = (w: number, h: number, reducedMotion: boolean, state: TraceState = doneState): Sim => {
  const layout = globeLayout(state);
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
    place(ctl.camera());
    const entities = Object.fromEntries([...poses].map(([k, p]) => {
      const v = new Vector3(...p.pos).project(cam);
      const inFrustum = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z >= -1 && v.z <= 1;
      return [String(k), {
        x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, world: p.pos,
        visible: p.opacity > VISIBLE_OPACITY && inFrustum,
      }];
    }));
    return { tMs: now, cut: ctl.cut(), entities };
  };
  return { ctl, run: (ms) => Array.from({ length: Math.round(ms / DT) }, frame) };
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
    frames.push(...sim.run(DIVE_MS + 300));
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

  it("focusHop outside the tunnel is declined (the globe view owns it)", () => {
    const sim = createSim(1280, 720, false);
    sim.run(10);
    expect(sim.ctl.focusHop(3)).toBe(false);
  });
});
