// ?test=1 → window.__lightpath drives the scene deterministically (no rAF, no wall clock).
import type { Vec3 } from "./geo";
import type { EntityFrame, Frame } from "./invariants";
import type { TraceState } from "./reducer";
import type { PoseMap } from "./scene/globePoses";

export interface TracedEntity extends EntityFrame {
  readonly world: Vec3;
  readonly opacity: number;
}
export interface TraceFrame extends Frame {
  readonly entities: Readonly<Record<string, TracedEntity>>;
}

export interface TestHooks {
  /** Advance one frame; `render: false` updates poses and camera without drawing (fast under software GL). */
  step(dtMs: number, render?: boolean): void;
  /** Per-entity screen position and visibility for this frame (input to invariants.checkTrace). */
  trace(): TraceFrame;
  state(): TraceState;
  /** Globe → tunnel; false when there is no origin to dive into yet. */
  dive?(): boolean;
  /** Tunnel → globe (also reverses a dive in progress). */
  surface?(): void;
  /** Focus a hop in the current view (tunnel: glide along the spline to its gate). */
  focusHop?(ttl: number): boolean;
  /** "globe" | "diving" | "tunnel" | "surfacing". */
  mode?(): string;
  /** 0 = globe … 1 = tunnel. */
  viewT?(): number;
}

export interface Projection {
  readonly x: number;
  readonly y: number;
  readonly inFrustum: boolean;
}

/** Visible means opacity > 0.01 and inside the view frustum (plan §G/S3.2). */
export const VISIBLE_OPACITY = 0.01;

export const isTestMode = (search: string): boolean => new URLSearchParams(search).get("test") === "1";

export const projectFrame = (tMs: number, poses: PoseMap, project: (p: Vec3) => Projection): TraceFrame => ({
  tMs,
  entities: Object.fromEntries([...poses].map(([k, pose]) => {
    const s = project(pose.pos);
    const e: TracedEntity = { x: s.x, y: s.y, visible: pose.opacity > VISIBLE_OPACITY && s.inFrustum, opacity: pose.opacity, world: pose.pos };
    return [String(k), e];
  })),
});

export const installTestHooks = (target: { __lightpath?: TestHooks }, hooks: TestHooks): void => {
  target.__lightpath = hooks;
};
