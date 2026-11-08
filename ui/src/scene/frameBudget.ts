// Frame-time governor for bloom: degrades one way only (full → half → off).
// Robust to startup hitches (warm-up), occasional stalls (median, not mean)
// and 30 Hz display caps such as Safari Low Power Mode (steady ~33.3 ms).

export type BloomTier = "full" | "half" | "off";

export interface BudgetOptions {
  /** Rolling window length in frames. */
  readonly window: number;
  /** Window median above this → half-resolution bloom. */
  readonly halfMs: number;
  /** Window median above this → bloom off. */
  readonly offMs: number;
  /** Single samples are capped so one stall (tab switch, GC) weighs like any slow frame. */
  readonly maxSampleMs: number;
  /** Frame time ignored at startup (shader compiles, asset decode). */
  readonly warmupMs: number;
  /** A display refresh cap: a steady cadence here is vsync, not GPU load. */
  readonly capMs: number;
  readonly capToleranceMs: number;
  /** Max interquartile range for a cadence to count as steady. */
  readonly steadyIqrMs: number;
}

export const DEFAULT_BUDGET: BudgetOptions = {
  window: 120, halfMs: 20, offMs: 28, maxSampleMs: 100,
  warmupMs: 2000, capMs: 1000 / 30, capToleranceMs: 2.5, steadyIqrMs: 2,
};

export interface FrameBudget {
  readonly tier: BloomTier;
  /** A pinned tier never changes (test mode, explicit override). */
  readonly pinned: boolean;
  /** Warm-up time still to ignore. */
  readonly warmupLeftMs: number;
  readonly samples: readonly number[];
}

const RANK: Readonly<Record<BloomTier, number>> = { full: 2, half: 1, off: 0 };

export const initialBudget = (tier: BloomTier = "full", pinned = false, opts: BudgetOptions = DEFAULT_BUDGET): FrameBudget =>
  ({ tier, pinned, warmupLeftMs: opts.warmupMs, samples: [] });

const quantile = (sorted: readonly number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

const judge = (samples: readonly number[], opts: BudgetOptions): BloomTier => {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const displayCapped = Math.abs(median - opts.capMs) <= opts.capToleranceMs && iqr <= opts.steadyIqrMs;
  if (displayCapped) return "full";
  return median > opts.offMs ? "off" : median > opts.halfMs ? "half" : "full";
};

export const sampleFrame = (b: FrameBudget, dtMs: number, opts: BudgetOptions = DEFAULT_BUDGET): FrameBudget => {
  if (b.pinned || b.tier === "off") return b;
  const dt = Math.min(Math.max(dtMs, 0), opts.maxSampleMs);
  if (b.warmupLeftMs > 0) return { ...b, warmupLeftMs: b.warmupLeftMs - Math.max(dtMs, 0) };
  const samples = [...b.samples, dt].slice(-opts.window);
  if (samples.length < opts.window) return { ...b, samples };
  const verdict = judge(samples, opts);
  // Never re-raise; a degradation starts a fresh window at the new tier.
  return RANK[verdict] < RANK[b.tier] ? { ...b, tier: verdict, samples: [] } : { ...b, samples };
};

/** WebGL UNMASKED_RENDERER strings that indicate CPU rasterisation. */
export const isSoftwareRenderer = (renderer: string): boolean =>
  /swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(renderer);
