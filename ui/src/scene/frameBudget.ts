// Frame-time governor for bloom: degrades one way only (full → half → off).

export type BloomTier = "full" | "half" | "off";

export interface BudgetOptions {
  /** Rolling window length in frames. */
  readonly window: number;
  /** Window average above this → half-resolution bloom. */
  readonly halfMs: number;
  /** Window average above this → bloom off. */
  readonly offMs: number;
  /** Single samples are capped so one stall (tab switch, GC) cannot degrade. */
  readonly maxSampleMs: number;
}

export const DEFAULT_BUDGET: BudgetOptions = { window: 120, halfMs: 20, offMs: 28, maxSampleMs: 100 };

export interface FrameBudget {
  readonly tier: BloomTier;
  /** A pinned tier never changes (test mode, explicit override). */
  readonly pinned: boolean;
  readonly samples: readonly number[];
}

const RANK: Readonly<Record<BloomTier, number>> = { full: 2, half: 1, off: 0 };

export const initialBudget = (tier: BloomTier = "full", pinned = false): FrameBudget => ({ tier, pinned, samples: [] });

const judge = (avg: number, opts: BudgetOptions): BloomTier =>
  avg > opts.offMs ? "off" : avg > opts.halfMs ? "half" : "full";

export const sampleFrame = (b: FrameBudget, dtMs: number, opts: BudgetOptions = DEFAULT_BUDGET): FrameBudget => {
  if (b.pinned || b.tier === "off") return b;
  const samples = [...b.samples, Math.min(Math.max(dtMs, 0), opts.maxSampleMs)].slice(-opts.window);
  if (samples.length < opts.window) return { ...b, samples };
  const verdict = judge(samples.reduce((s, x) => s + x, 0) / samples.length, opts);
  // Never re-raise; a degradation starts a fresh window at the new tier.
  return RANK[verdict] < RANK[b.tier] ? { ...b, tier: verdict, samples: [] } : { ...b, samples };
};

/** WebGL UNMASKED_RENDERER strings that indicate CPU rasterisation. */
export const isSoftwareRenderer = (renderer: string): boolean =>
  /swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(renderer);
