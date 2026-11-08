// @vitest-environment jsdom
import { Group, type Object3D } from "three";
import { describe, expect, it } from "vitest";
import { latLonToVec3, type Vec3 } from "../geo";
import { createGates, type GateFrameInput } from "./gates";
import { ORIGIN_KEY, type Pose } from "./globePoses";
import { tunnelFrame, tunnelPoint, type TunnelGate } from "./tunnelLayout";

const frame = tunnelFrame(latLonToVec3(40, -74), [0, 1, 0]);
const gate = (ttl: number, s: number): TunnelGate => ({ ttl, s, title: `hop ${ttl}`, detail: "", color: "#22e6ff", broken: false });
const at = (s: number): Pose => ({ pos: tunnelPoint(frame, s), scale: 1, opacity: 1, morph: 1 });

const input = (generation: number): GateFrameInput => {
  const gates = [gate(1, 0.6), gate(2, 1.2)];
  return {
    generation,
    poses: new Map([[ORIGIN_KEY, at(0)], ...gates.map((g) => [g.ttl, at(g.s)] as const)]),
    gates,
    depths: new Map([[ORIGIN_KEY, 0], ...gates.map((g) => [g.ttl, g.s] as const)]),
    frame,
    cameraPos: tunnelPoint(frame, 0.1),
    cameraFwd: frame.n as Vec3,
    ringFade: 1, labelFade: 1, nowMs: 0, reducedMotion: false, aspect: 16 / 9,
  };
};

describe("createGates", () => {
  it("rebuilds every hop's gate and label on a new trace generation; the mouth ring persists", () => {
    const parent = new Group();
    const gates = createGates(parent);
    gates.update(input(1));
    const first: Object3D[] = [...parent.children];
    gates.update(input(1));
    expect(parent.children).toEqual(first);

    gates.update(input(2));
    const kept = parent.children.filter((o) => first.includes(o));
    expect(parent.children).toHaveLength(first.length);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.children.length).toBeGreaterThan(0); // the mouth ring group, not a label
    gates.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
