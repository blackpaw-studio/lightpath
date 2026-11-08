// The single per-frame pose source for both views. Wraps the globe source and
// carries each hop from its globe position to its tunnel gate by viewT; node
// sprites, arcs, gates and labels all read the one PoseMap this produces.
import { lerp3, type Vec3 } from "../geo";
import { smoothstep } from "./easing";
import { ORIGIN_KEY, type PoseInput, type PoseMap, type PoseSource } from "./globePoses";
import { tunnelPoint, type TunnelFrame, type TunnelGate } from "./tunnelLayout";

/** viewT window over which hops fly from globe to gate (plan §G: 0.35→0.85). */
export const FLIGHT = [0.3, 0.8] as const;
/** viewT window over which a node's dot opens into its gate ring. */
export const MORPH = [0.45, 0.85] as const;
/** Time constant for a gate gliding to a new depth (a hop inserted out of order). */
export const GATE_GLIDE_TAU_MS = 220;

/** Pure: globe poses carried toward gate positions. Opacity and scale are never touched. */
export const blendPoses = (globe: PoseMap, gates: ReadonlyMap<number, Vec3>, viewT: number): PoseMap => {
  const flight = smoothstep(FLIGHT[0], FLIGHT[1], viewT);
  const morph = smoothstep(MORPH[0], MORPH[1], viewT);
  return new Map([...globe].map(([k, g]) => {
    const gate = gates.get(k);
    return [k, { pos: gate ? lerp3(g.pos, gate, flight) : g.pos, scale: g.scale, opacity: g.opacity, morph }] as const;
  }));
};

/** Pure: smoothed gate depths. New gates start at their target; moved gates glide toward it. */
export const stepGateDepths = (
  prev: ReadonlyMap<number, number>, gates: readonly TunnelGate[], dtMs: number,
): Map<number, number> => {
  const k = 1 - Math.exp(-Math.max(dtMs, 0) / GATE_GLIDE_TAU_MS);
  return new Map([[ORIGIN_KEY, 0], ...gates.map((g): [number, number] => {
    const p = prev.get(g.ttl);
    return [g.ttl, p === undefined ? g.s : p + (g.s - p) * k];
  })]);
};

export interface TunnelPoseView {
  readonly viewT: number;
  /** Null until the first dive anchors the tunnel at the origin node. */
  readonly frame: TunnelFrame | null;
  readonly gates: readonly TunnelGate[];
}

export interface TunnelPoseSource {
  /** Call exactly once per frame (it advances gate glides). */
  readonly source: PoseSource;
  /** Smoothed depth per key this frame (origin = 0). */
  depths(): ReadonlyMap<number, number>;
}

export const createTunnelPoseSource = (globe: PoseSource, view: () => TunnelPoseView): TunnelPoseSource => {
  let depths: ReadonlyMap<number, number> = new Map();
  return {
    source: (input: PoseInput) => {
      const poses = globe(input);
      const v = view();
      depths = stepGateDepths(depths, v.gates, input.dtMs);
      const frame = v.frame;
      if (!frame) return poses;
      const gates = new Map([...depths].map(([k, s]) => [k, tunnelPoint(frame, s)] as const));
      return blendPoses(poses, gates, v.viewT);
    },
    depths: () => depths,
  };
};
