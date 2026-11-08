// Globe-view pose source. Nodes and arcs never own positions: each frame they
// read a PoseMap. The tunnel lane's poses.ts wraps this (lerping toward gate
// poses by viewT) without changing the consumers.
import { slerpGreatCircle, type Vec3 } from "../geo";
import type { GlobeLayout } from "./layout";

export interface Pose {
  /** World-space position. */
  readonly pos: Vec3;
  readonly scale: number;
  readonly opacity: number;
  /** 0 = globe node (glowing dot) … 1 = tunnel gate (ring). Set by the tunnel lane; absent means 0. */
  readonly morph?: number;
}
/** Keyed by ttl; the origin uses ORIGIN_KEY. */
export type PoseMap = ReadonlyMap<number, Pose>;

export const ORIGIN_KEY = 0;
export const APPEAR_MS = 400;
/** Time constant for gliding a hop whose layout position changed (hop.update geo, re-estimation). */
export const GLIDE_TAU_MS = 220;

export interface PoseInput {
  readonly layout: GlobeLayout;
  readonly nowMs: number;
  readonly dtMs: number;
  readonly reducedMotion: boolean;
  /** Globe idle rotation about +y, radians. */
  readonly rotationY: number;
}

export interface GlobePoseState {
  readonly generation: number;
  /** Smoothed globe-local unit positions. */
  readonly local: ReadonlyMap<number, Vec3>;
  readonly bornAt: ReadonlyMap<number, number>;
}

export const emptyPoseState: GlobePoseState = { generation: 0, local: new Map(), bornAt: new Map() };

/** A new trace keeps only the origin (the user's own location) and restarts every hop. */
const forGeneration = (s: GlobePoseState, generation: number): GlobePoseState => {
  if (s.generation === generation) return s;
  const keep = <V>(m: ReadonlyMap<number, V>): Map<number, V> =>
    new Map([...m].filter(([k]) => k === ORIGIN_KEY));
  return { generation, local: keep(s.local), bornAt: keep(s.bornAt) };
};

const BACK_C1 = 1.70158;
const easeOutBack = (t: number): number => 1 + (BACK_C1 + 1) * (t - 1) ** 3 + BACK_C1 * (t - 1) ** 2;

/** "Bloom in": ease-out-back scale pop, or an opacity fade under reduced motion. */
export const appearance = (ageMs: number, reducedMotion: boolean): { scale: number; opacity: number } => {
  const t = Math.min(Math.max(ageMs / APPEAR_MS, 0), 1);
  if (t >= 1) return { scale: 1, opacity: 1 };
  if (reducedMotion) return { scale: 1, opacity: t };
  return { scale: t <= 0 ? 0 : easeOutBack(t), opacity: 1 };
};

export const rotateY = ([x, y, z]: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c + z * s, y, -x * s + z * c];
};

const glide = (from: Vec3, to: Vec3, dtMs: number): Vec3 =>
  slerpGreatCircle(from, to, 1 - Math.exp(-Math.max(dtMs, 0) / GLIDE_TAU_MS));

interface PoseBuffers {
  readonly local: Map<number, Vec3>;
  readonly bornAt: Map<number, number>;
  readonly poses: Map<number, Pose>;
}

const newBuffers = (): PoseBuffers => ({ local: new Map(), bornAt: new Map(), poses: new Map() });

/** Core step: clears `out` and fills it from `prevState`. `out` must not alias `prevState`'s maps. */
const stepInto = (prevState: GlobePoseState, input: PoseInput, out: PoseBuffers): GlobePoseState => {
  const prev = forGeneration(prevState, input.layout.generation);
  // Until a real anchor exists the origin stays where it was rather than vanishing.
  const origin = input.layout.origin ?? prev.local.get(ORIGIN_KEY) ?? null;
  out.local.clear();
  out.bornAt.clear();
  out.poses.clear();
  const place = (k: number, target: Vec3): void => {
    const p = prev.local.get(k);
    const pos = p ? glide(p, target, input.dtMs) : target;
    const born = prev.bornAt.get(k) ?? input.nowMs;
    out.local.set(k, pos);
    out.bornAt.set(k, born);
    out.poses.set(k, { pos: rotateY(pos, input.rotationY), ...appearance(input.nowMs - born, input.reducedMotion) });
  };
  if (origin) place(ORIGIN_KEY, origin);
  for (const h of input.layout.hops) place(h.ttl, h.pos);
  return { generation: prev.generation, local: out.local, bornAt: out.bornAt };
};

/** Pure: advance smoothed positions one frame and produce this frame's poses. */
export const stepGlobePoses = (prevState: GlobePoseState, input: PoseInput): { state: GlobePoseState; poses: PoseMap } => {
  const out = newBuffers();
  return { state: stepInto(prevState, input, out), poses: out.poses };
};

/** Per-frame pose producer. The tunnel lane composes over this one. */
export type PoseSource = (input: PoseInput) => PoseMap;

/**
 * Stateful wrapper over the same step; call exactly once per frame. Maps are
 * double-buffered: the previous frame's PoseMap stays valid for one more
 * frame, then its storage is reused.
 */
export const createGlobePoseSource = (): PoseSource => {
  const buffers = [newBuffers(), newBuffers()] as const;
  let state = emptyPoseState;
  let frame = 0;
  return (input) => {
    const out = buffers[frame++ % 2]!;
    state = stepInto(state, input, out);
    return out.poses;
  };
};
