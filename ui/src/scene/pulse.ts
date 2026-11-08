// Per-vertex brightness along an arc: a travelling light pulse that draws the
// arc behind it, then a resting glow with occasional data packets.

export const PULSE_MS = 800;
export const REST_GLOW = 0.55;
const FADE_IN_MS = 400;
const HEAD_GAIN = 3.2;
const HEAD_WIDTH = 0.07;
const HEAD_FADE_MS = 400;
const PACKET_GAIN = 0.9;
const PACKET_WIDTH = 0.035;
const PACKET_RATE_HZ = 0.3;
const ESTIMATED_DIM = 0.6;

export interface PulseOptions {
  readonly reducedMotion: boolean;
  readonly estimated: boolean;
  /** 0..1 per-arc phase offset for packets. */
  readonly seed: number;
}

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/** Head position along the arc (0..1), eased in-out over PULSE_MS. */
export const pulseHead = (ageMs: number): number => {
  const t = clamp01(ageMs / PULSE_MS);
  return t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t);
};

/** Brightness at arc parameter u ∈ [0,1] for an arc `ageMs` old at virtual time `nowMs`. */
export const pulseIntensity = (u: number, ageMs: number, nowMs: number, o: PulseOptions): number => {
  const rest = o.estimated ? REST_GLOW * ESTIMATED_DIM : REST_GLOW;
  if (o.reducedMotion) return rest * clamp01(ageMs / FADE_IN_MS);
  const h = pulseHead(ageMs);
  if (u > h) return 0;
  const headFade = ageMs < PULSE_MS ? 1 : clamp01(1 - (ageMs - PULSE_MS) / HEAD_FADE_MS);
  const head = HEAD_GAIN * headFade * Math.exp(-(((h - u) / HEAD_WIDTH) ** 2));
  const phase = (((nowMs / 1000) * PACKET_RATE_HZ + o.seed) % 1 + 1) % 1;
  const packet = PACKET_GAIN * clamp01((ageMs - PULSE_MS) / 600) * Math.exp(-(((u - phase) / PACKET_WIDTH) ** 2));
  return rest + head + packet;
};
