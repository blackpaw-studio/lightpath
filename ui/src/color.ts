import type { Probe } from "./protocol";

export type Lab = readonly [number, number, number];

export const NO_RTT_COLOR = "#4a5266";

const STOPS: readonly { ms: number; hex: string }[] = [
  { ms: 20, hex: "#22e6ff" },
  { ms: 80, hex: "#9b5cff" },
  { ms: 200, hex: "#ff3b4f" },
];

export const meanRtt = (probes: readonly Probe[]): number | null => {
  const xs = probes.flatMap((p) => (p.rttMs === null ? [] : [p.rttMs]));
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
};

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** "#rrggbb" → OKLab (Ottosson). */
export const srgbToOklab = (hex: string): Lab => {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

export const oklabToSrgb = ([L, a, b]: Lab): string => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const byte = (c: number): string =>
    Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255).toString(16).padStart(2, "0");
  return "#" + linear.map(byte).join("");
};

const mixLab = (a: Lab, b: Lab, t: number): Lab => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Mean RTT (ms) → cyan ≤20 → violet 80 → red ≥200, linear in OKLab; null → dim grey. */
export const rttColor = (rttMs: number | null): string => {
  if (rttMs === null || !Number.isFinite(rttMs)) return NO_RTT_COLOR;
  const first = STOPS[0]!;
  const last = STOPS[STOPS.length - 1]!;
  if (rttMs <= first.ms) return first.hex;
  if (rttMs >= last.ms) return last.hex;
  const hi = STOPS.find((s) => rttMs <= s.ms)!;
  const lo = STOPS[STOPS.indexOf(hi) - 1]!;
  if (rttMs === hi.ms) return hi.hex;
  const t = (rttMs - lo.ms) / (hi.ms - lo.ms);
  return oklabToSrgb(mixLab(srgbToOklab(lo.hex), srgbToOklab(hi.hex), t));
};
