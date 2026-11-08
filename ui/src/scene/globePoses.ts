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
  /** Smoothed globe-local unit positions. */
  readonly local: ReadonlyMap<number, Vec3>;
  readonly bornAt: ReadonlyMap<number, number>;
}

export const emptyPoseState: GlobePoseState = { local: new Map(), bornAt: new Map() };

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

/** Pure: advance smoothed positions one frame and produce this frame's poses. */
export const stepGlobePoses = (prev: GlobePoseState, input: PoseInput): { state: GlobePoseState; poses: PoseMap } => {
  const targets: [number, Vec3][] = [[ORIGIN_KEY, input.layout.origin], ...input.layout.hops.map((h): [number, Vec3] => [h.ttl, h.pos])];
  const local = new Map(targets.map(([k, target]) => {
    const p = prev.local.get(k);
    return [k, p ? glide(p, target, input.dtMs) : target] as const;
  }));
  const bornAt = new Map(targets.map(([k]) => [k, prev.bornAt.get(k) ?? input.nowMs] as const));
  const poses = new Map([...local].map(([k, pos]) => {
    const look = appearance(input.nowMs - bornAt.get(k)!, input.reducedMotion);
    return [k, { pos: rotateY(pos, input.rotationY), ...look }] as const;
  }));
  return { state: { local, bornAt }, poses };
};
