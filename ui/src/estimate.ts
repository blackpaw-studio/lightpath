import { slerpGreatCircle, type Vec3 } from "./geo";

export interface LocatedHop {
  readonly ttl: number;
  readonly pos: Vec3;
}

const pick = (hops: readonly LocatedHop[], better: (a: LocatedHop, b: LocatedHop) => boolean): LocatedHop | null =>
  hops.reduce<LocatedHop | null>((m, h) => (m === null || better(h, m) ? h : m), null);

/**
 * Position for a hop without geo: on the great circle between the nearest
 * located neighbours at (ttl−prev)/(next−prev). Only a previous neighbour →
 * that neighbour; only a next neighbour (or none) → the origin.
 */
export const estimatePosition = (ttl: number, located: readonly LocatedHop[], origin: Vec3): Vec3 => {
  const prev = pick(located.filter((h) => h.ttl < ttl), (a, b) => a.ttl > b.ttl);
  const next = pick(located.filter((h) => h.ttl > ttl), (a, b) => a.ttl < b.ttl);
  if (prev && next) return slerpGreatCircle(prev.pos, next.pos, (ttl - prev.ttl) / (next.ttl - prev.ttl));
  return prev ? prev.pos : origin;
};
