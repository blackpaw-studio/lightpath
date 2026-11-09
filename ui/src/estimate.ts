import { slerpGreatCircle, type Vec3 } from "./geo";

export interface LocatedHop {
  readonly ttl: number;
  readonly pos: Vec3;
  /** Smallest reply delay; lets hops between located neighbours be placed by delay instead of by ttl. */
  readonly rttMs?: number | null;
}

/** A hop with no location of its own. */
export interface EstimatedHop {
  readonly ttl: number;
  readonly rttMs: number | null;
}

const pick = (hops: readonly LocatedHop[], better: (a: LocatedHop, b: LocatedHop) => boolean): LocatedHop | null =>
  hops.reduce<LocatedHop | null>((m, h) => (m === null || better(h, m) ? h : m), null);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Fraction (0 at `prev`, 1 at `next`) for each hop of a run between two located neighbours, in ttl order. */
const runFractions = (run: readonly EstimatedHop[], prev: LocatedHop, next: LocatedHop): number[] => {
  const r0 = prev.rttMs ?? null;
  const r1 = next.rttMs ?? null;
  // Known points, in ttl order: the anchors, and (by delay) every hop that has one. A later hop never
  // lands behind an earlier one, so nodes never cross.
  const known: { ttl: number; f: number }[] = [{ ttl: prev.ttl, f: 0 }];
  if (r0 !== null && r1 !== null && r1 > r0) {
    for (const h of run) {
      if (h.rttMs === null) continue;
      known.push({ ttl: h.ttl, f: Math.max(clamp01((h.rttMs - r0) / (r1 - r0)), known[known.length - 1]!.f) });
    }
  }
  known.push({ ttl: next.ttl, f: 1 });
  // Everything else sits by ttl between the nearest known points on either side.
  return run.map((h) => {
    const exact = known.find((k) => k.ttl === h.ttl);
    if (exact) return exact.f;
    const lo = known.filter((k) => k.ttl < h.ttl).at(-1)!;
    const hi = known.find((k) => k.ttl > h.ttl)!;
    return lo.f + ((hi.f - lo.f) * (h.ttl - lo.ttl)) / (hi.ttl - lo.ttl);
  });
};

interface Run {
  readonly prev: LocatedHop | null;
  readonly next: LocatedHop | null;
  readonly hops: EstimatedHop[];
}

/**
 * Positions for hops without geo. A run of them between two located neighbours
 * lies on the great circle between those neighbours: at each hop's reply-delay
 * fraction when both neighbours and the hop have a delay (a 10 ms hop between a
 * 9 ms and a 72 ms neighbour sits next to the first), else at (ttl-prev)/(next-prev).
 * Only a previous neighbour: that neighbour. Only a next neighbour (or none): the origin.
 */
export const estimatePositions = (
  hops: readonly EstimatedHop[], located: readonly LocatedHop[], origin: Vec3,
): ReadonlyMap<number, Vec3> => {
  const runs = new Map<string, Run>();
  for (const h of [...hops].sort((a, b) => a.ttl - b.ttl)) {
    const prev = pick(located.filter((l) => l.ttl < h.ttl), (a, b) => a.ttl > b.ttl);
    const next = pick(located.filter((l) => l.ttl > h.ttl), (a, b) => a.ttl < b.ttl);
    const key = String(prev?.ttl) + ":" + String(next?.ttl);
    const run = runs.get(key) ?? { prev, next, hops: [] };
    run.hops.push(h);
    runs.set(key, run);
  }
  const placed = new Map<number, Vec3>();
  for (const { prev, next, hops: run } of runs.values()) {
    if (!prev || !next) {
      run.forEach((h) => placed.set(h.ttl, prev ? prev.pos : origin));
      continue;
    }
    const fractions = runFractions(run, prev, next);
    run.forEach((h, i) => placed.set(h.ttl, slerpGreatCircle(prev.pos, next.pos, fractions[i]!)));
  }
  return placed;
};

/** One hop's position by its ttl alone (see estimatePositions). */
export const estimatePosition = (ttl: number, located: readonly LocatedHop[], origin: Vec3): Vec3 =>
  estimatePositions([{ ttl, rttMs: null }], located, origin).get(ttl)!;
