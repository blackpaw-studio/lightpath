import { describe, expect, it } from "vitest";
import { latLonToVec3, sub, type Vec3 } from "../geo";
import { checkTrace, type Frame } from "../invariants";
import { ORIGIN_KEY, type Pose, type PoseInput, type PoseMap } from "./globePoses";
import { blendPoses, createTunnelPoseSource, FLIGHT, type TunnelPoseView } from "./poses";
import { MIN_GAP, tunnelFrame, tunnelPoint, type TunnelGate } from "./tunnelLayout";

const pose = (pos: Vec3, opacity = 1, scale = 1): Pose => ({ pos, scale, opacity });
const globe: PoseMap = new Map([
  [ORIGIN_KEY, pose(latLonToVec3(40, -74))],
  [1, pose(latLonToVec3(51, 0), 0.7, 0.4)],
  [2, pose(latLonToVec3(35, 139))],
]);
const gates = new Map<number, Vec3>([[ORIGIN_KEY, [0, 0, 0.5]], [1, [0.1, 0, -0.2]], [2, [0, 0.1, -3]]]);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(...sub(a, b));

describe("blendPoses", () => {
  it("viewT 0 is exactly the globe pose, unmorphed", () => {
    const out = blendPoses(globe, gates, 0);
    globe.forEach((g, k) => expect(out.get(k)).toEqual({ ...g, morph: 0 }));
  });

  it("viewT 1 puts every hop at its gate, fully morphed, opacity and scale untouched", () => {
    const out = blendPoses(globe, gates, 1);
    globe.forEach((g, k) => expect(out.get(k)).toEqual({ pos: gates.get(k), scale: g.scale, opacity: g.opacity, morph: 1 }));
  });

  it("a hop with no gate stays on the globe", () => {
    const out = blendPoses(globe, new Map(), 1);
    expect(out.get(2)!.pos).toEqual(globe.get(2)!.pos);
  });

  it("is continuous: 1/600 viewT steps never move a pose more than the smoothstep slope allows", () => {
    const series = Array.from({ length: 601 }, (_, i) => blendPoses(globe, gates, i / 600));
    globe.forEach((g, k) => {
      const span = dist(g.pos, gates.get(k)!);
      const bound = (span * 1.5) / (FLIGHT[1] - FLIGHT[0]) / 600;
      const steps = series.slice(1).map((m, i) => dist(m.get(k)!.pos, series[i]!.get(k)!.pos));
      expect(Math.max(...steps)).toBeLessThanOrEqual(bound * 1.0001);
      series.forEach((m) => expect(m.get(k)!.opacity).toBe(g.opacity));
    });
  });
});

describe("createTunnelPoseSource", () => {
  const origin = latLonToVec3(40, -74);
  const frame = tunnelFrame(origin, [0, 1, 0]);
  const gate = (ttl: number, s: number): TunnelGate =>
    ({ ttl, s, title: "", detail: "", color: "#22e6ff", broken: false });
  const input = (nowMs: number, generation = 0): PoseInput => ({
    layout: { generation, origin, hops: [] }, nowMs, dtMs: 1000 / 60, reducedMotion: false, rotationY: 0,
  });
  const globePoses = (keys: number[]): PoseMap => new Map(keys.map((k) => [k, pose(origin)]));

  const runTunnel = (schedule: (frame: number) => readonly TunnelGate[], frames: number): Frame[] => {
    let gates = schedule(0);
    const view = (): TunnelPoseView => ({ viewT: 1, frame, gates });
    const src = createTunnelPoseSource(() => globePoses([ORIGIN_KEY, ...gates.map((g) => g.ttl)]), view);
    return Array.from({ length: frames }, (_, i) => {
      gates = schedule(i);
      const poses = src.source(input(i * 1000 / 60));
      return {
        tMs: i * 1000 / 60,
        entities: Object.fromEntries([...poses].map(([k, p]) => [String(k), { x: 0, y: 0, visible: true, world: p.pos }])),
      };
    });
  };

  it("a new trace generation restarts depths: a reused ttl starts at its new depth instead of gliding from the old trace", () => {
    let gates = [gate(1, 0.6), gate(3, 4)];
    const src = createTunnelPoseSource(
      () => globePoses([ORIGIN_KEY, ...gates.map((g) => g.ttl)]), () => ({ viewT: 1, frame, gates }),
    );
    src.source(input(0, 1));
    gates = [gate(1, 0.6), gate(3, 1.2)];
    const poses = src.source(input(1000 / 60, 2));
    expect(src.depths().get(3)).toBe(1.2);
    expect(dist(poses.get(3)!.pos, tunnelPoint(frame, 1.2))).toBeLessThan(1e-12);
  });

  it("an out-of-order hop pushes later gates deeper by gliding, never a depth teleport", () => {
    // ttl 3 is laid out at s=1.2; then ttl 2 arrives late and pushes it to 1.8.
    const before = [gate(1, 0.6), gate(3, 1.2)];
    const after = [gate(1, 0.6), gate(2, 1.2), gate(3, 1.2 + MIN_GAP)];
    const trace = runTunnel((i) => (i < 10 ? before : after), 120);
    expect(checkTrace(trace, { maxJumpPx: 48, flickerWindowMs: 1000, maxJumpWorld: 0.1 })).toEqual([]);
    const last = trace[trace.length - 1]!.entities["3"]!.world!;
    expect(dist(last, tunnelPoint(frame, 1.2 + MIN_GAP))).toBeLessThan(1e-3);
  });

  it("a newly arrived hop starts at its own depth (it pops in there, it does not slide from the mouth)", () => {
    const trace = runTunnel((i) => (i < 5 ? [gate(1, 0.6)] : [gate(1, 0.6), gate(2, 4)]), 6);
    expect(dist(trace[5]!.entities["2"]!.world!, tunnelPoint(frame, 4))).toBeLessThan(1e-12);
  });

  it("the origin sits at the tunnel mouth", () => {
    const trace = runTunnel(() => [gate(1, 0.6)], 1);
    expect(dist(trace[0]!.entities[String(ORIGIN_KEY)]!.world!, origin)).toBeLessThan(1e-12);
  });

  it("without an anchored frame the globe poses pass through untouched", () => {
    const g = globePoses([ORIGIN_KEY, 1]);
    const src = createTunnelPoseSource(() => g, () => ({ viewT: 0, frame: null, gates: [gate(1, 0.6)] }));
    expect(src.source(input(0))).toBe(g);
  });
});
