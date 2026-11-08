// Gate-label declutter: deep in the tunnel, gates converge on the vanishing
// point and their labels would stack. Only the nearest gates ahead keep a
// label; the rank is "soft" (a smooth count of nearer gates), so a label fades
// rather than pops as the camera moves or gates glide.

/** Gates closer than this ahead of the camera (or behind it) carry no label and do not count. */
const NEAR: readonly [number, number] = [0.08, 0.5];
/** Width over which two gates' order blends (gates are at least MIN_GAP = 0.6 apart). */
const ORDER_BLEND = 0.25;
/** Soft rank at which labels fade out: ranks 0 and 1 full, rank 2 partial, rank 3+ hidden. */
const RANK_FADE: readonly [number, number] = [1.5, 2.8];

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Label opacity factor per gate, from each gate's signed distance ahead of the
 * camera along its view direction (same order as the input).
 */
export const labelVisibility = (ahead: readonly number[]): number[] => {
  const present = ahead.map((a) => smoothstep(NEAR[0], NEAR[1], a));
  return ahead.map((a, i) => {
    const rank = ahead.reduce(
      (n, b, j) => (j === i ? n : n + present[j]! * smoothstep(-ORDER_BLEND, ORDER_BLEND, a - b)), 0,
    );
    return present[i]! * (1 - smoothstep(RANK_FADE[0], RANK_FADE[1], rank));
  });
};
