// The shape of each globe arc, owned by the per-frame pose source (one source per frame).
// An arc is a piece of a run of estimated hops between two located anchors: its altitude follows
// the run's single hump (see ArcSpan), so its extent along the run comes from where its endpoints
// are drawn. When the run's structure changes (a split, a merge, a doubt flip, a destination
// arriving) the target shape jumps; the drawn shape starts where it was and eases onto it over
// the nodes' glide time constant, so the hump never steps.
import { angularDistance, type Vec3 } from "../geo";
import type { ArcSpan } from "./arcGeometry";
import type { LaidHop } from "./layout";

/** Time constant of the ease onto a new target shape (the nodes' glide constant). */
export const SHAPE_TAU_MS = 220;
const MIN_RUN_ANGLE = 1e-4;

/** What a pose carries for the arc into its hop. `snapped`: reduced motion took a shape change as a cut. */
export interface ArcShape extends ArcSpan {
  readonly snapped?: boolean;
}

export interface ArcShapeEntry {
  /** Which run the arc belongs to ("from:to" of its anchors), or "" for a plain arc. */
  readonly key: string;
  readonly shape: ArcSpan;
  /** Shape minus target: what is still to ease out. */
  readonly offset: ArcSpan;
}
export type ArcShapeState = ReadonlyMap<number, ArcShapeEntry>;

interface Target {
  readonly key: string;
  readonly shape: ArcSpan;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const ZERO: ArcSpan = { t0: 0, t1: 0, theta: 0 };
const sub = (a: ArcSpan, b: ArcSpan): ArcSpan => ({ t0: a.t0 - b.t0, t1: a.t1 - b.t1, theta: a.theta - b.theta });
const add = (a: ArcSpan, b: ArcSpan): ArcSpan => ({ t0: a.t0 + b.t0, t1: a.t1 + b.t1, theta: a.theta + b.theta });
const scale = (a: ArcSpan, k: number): ArcSpan => ({ t0: a.t0 * k, t1: a.t1 * k, theta: a.theta * k });

/**
 * For each layout hop index, the anchors (ttls) of the run its arc belongs to: a maximal run of
 * estimated hops with a located hop on each side, which estimatePositions puts on one great circle.
 * Runs without both anchors (their hops pile onto one point) have no entry.
 */
export const runAnchors = (hops: readonly LaidHop[]): ReadonlyMap<number, { readonly from: number; readonly to: number }> => {
  const runs = new Map<number, { from: number; to: number }>();
  for (let i = 0; i < hops.length;) {
    if (hops[i]!.located) { i++; continue; }
    let j = i;
    while (j + 1 < hops.length && !hops[j + 1]!.located) j++;
    const from = hops[i - 1];
    const to = hops[j + 1];
    if (from && to) for (let k = i; k <= j + 1; k++) runs.set(k, { from: from.ttl, to: to.ttl });
    i = j + 1;
  }
  return runs;
};

/** Every arc's target shape from the hops' smoothed globe-local positions (keyed by the ttl the arc ends at). */
export const targetShapes = (hops: readonly LaidHop[], local: ReadonlyMap<number, Vec3>, originKey: number): ReadonlyMap<number, Target> => {
  const runs = runAnchors(hops);
  const targets = new Map<number, Target>();
  hops.forEach((h, i) => {
    const fromKey = hops[i - 1]?.ttl ?? originKey;
    const p0 = local.get(fromKey);
    const p1 = local.get(h.ttl);
    if (!p0 || !p1) return;
    const run = runs.get(i);
    const a = run && local.get(run.from);
    const b = run && local.get(run.to);
    const theta = a && b ? angularDistance(a, b) : 0;
    targets.set(h.ttl, run && a && b && theta >= MIN_RUN_ANGLE
      ? { key: `${run.from}:${run.to}`, shape: { t0: clamp01(angularDistance(a, p0) / theta), t1: clamp01(angularDistance(a, p1) / theta), theta } }
      : { key: "", shape: { t0: 0, t1: 1, theta: angularDistance(p0, p1) } });
  });
  return targets;
};

/**
 * Advance the drawn shapes one frame. A target that moves with its endpoints is followed exactly; only a
 * change of run structure is eased (under reduced motion it is taken at once and flagged as a cut).
 * Arcs not in `targets` are dropped, so a new trace starts clean.
 */
export const stepArcShapes = (
  prev: ArcShapeState, targets: ReadonlyMap<number, Target>, dtMs: number, reducedMotion: boolean,
): { state: Map<number, ArcShapeEntry>; shapes: Map<number, ArcShape> } => {
  const decay = Math.exp(-Math.max(dtMs, 0) / SHAPE_TAU_MS);
  const state = new Map<number, ArcShapeEntry>();
  const shapes = new Map<number, ArcShape>();
  for (const [ttl, t] of targets) {
    const before = prev.get(ttl);
    const changed = before !== undefined && before.key !== t.key;
    const carried = !before ? ZERO : changed ? sub(before.shape, t.shape) : before.offset;
    const offset = reducedMotion ? ZERO : scale(carried, decay);
    const shape = add(t.shape, offset);
    state.set(ttl, { key: t.key, shape, offset });
    shapes.set(ttl, { ...shape, ...(reducedMotion && changed ? { snapped: true } : {}) });
  }
  return { state, shapes };
};
