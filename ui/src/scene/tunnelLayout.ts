// Pure tunnel geometry: where each hop's gate sits along the helix, and the
// local frame anchoring the tunnel at the origin node (+z = inward normal).
import { meanRtt, NO_RTT_COLOR, rttColor } from "../color";
import { add, cross, dot, normalize, scale, sub, type Vec3 } from "../geo";
import type { Hop } from "../protocol";
import type { TraceState } from "../reducer";

/** Smallest gap between consecutive gates (world units). */
export const MIN_GAP = 0.6;
/** Gap per ms of RTT increase over the previous hop. */
export const RTT_GAP_K = 0.025;
/** Helix radius, turn rate (rad per unit s), and the depth over which it eases in from the axis. */
export const HELIX_R = 0.2;
export const HELIX_OMEGA = (2 * Math.PI) / 7;
const HELIX_RAMP = 1.6;

export interface GateLabel {
  readonly ttl: number;
  readonly title: string;
  readonly detail: string;
}

export interface TunnelGate extends GateLabel {
  /** Depth along the tunnel (arc-length parameter of the helix). */
  readonly s: number;
  readonly color: string;
  /** Timeout-only hop: drawn as a dim, broken ring. */
  readonly broken: boolean;
}

/** Local tunnel frame: u = screen right, v = screen up, n = inward normal (down the tunnel). */
export interface TunnelFrame {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
}

/**
 * Gate depths: s_i = s_{i-1} + max(MIN_GAP, k·max(0, rtt_i − rtt_{i-1})), from
 * the origin at s = 0 with RTT 0. A timeout (null) adds MIN_GAP and keeps the
 * last known RTT as the baseline for the next hop.
 */
export const gateSpacing = (rtts: readonly (number | null)[], minGap = MIN_GAP, k = RTT_GAP_K): number[] => {
  const out: number[] = [];
  let s = 0;
  let base = 0;
  for (const rtt of rtts) {
    s += rtt === null ? minGap : Math.max(minGap, k * Math.max(0, rtt - base));
    if (rtt !== null) base = rtt;
    out.push(s);
  }
  return out;
};

export const isTimeoutHop = (h: Hop): boolean => h.probes.every((p) => p.rttMs === null);

/** "hostname · ASN/org · RTT" split into a title line and a detail line. */
export const gateLabel = (h: Hop): GateLabel => {
  const rtt = meanRtt(h.probes);
  const as = [h.asn === null ? null : `AS${h.asn}`, h.org].filter((x): x is string => x !== null).join(" ");
  const timing = rtt === null ? "no reply" : `${rtt.toFixed(1)} ms`;
  return {
    ttl: h.ttl,
    title: h.host ?? h.ip ?? "* * *",
    detail: [as, timing].filter((x) => x.length > 0).join(" · "),
  };
};

/** Pure: reducer state → gates in ttl order. */
export const tunnelGates = (state: TraceState): TunnelGate[] => {
  const rtts = state.hops.map((h) => meanRtt(h.probes));
  const s = gateSpacing(rtts);
  return state.hops.map((h, i) => {
    const broken = isTimeoutHop(h);
    return { ...gateLabel(h), s: s[i]!, broken, color: broken ? NO_RTT_COLOR : rttColor(rtts[i] ?? null) };
  });
};

/** Helix point in the local frame; starts on the axis heading straight down +z. */
export const helixLocal = (s: number): Vec3 => {
  const r = HELIX_R * (1 - Math.exp(-((s / HELIX_RAMP) ** 2)));
  return [r * Math.sin(HELIX_OMEGA * s), r * Math.cos(HELIX_OMEGA * s), s];
};

const anyPerpendicular = (n: Vec3): Vec3 => normalize(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));

/** Frame at `origin` (a point on the unit sphere) with v as close to `upHint` as the normal allows. */
export const tunnelFrame = (origin: Vec3, upHint: Vec3): TunnelFrame => {
  const n = normalize(scale(origin, -1));
  const projected = sub(upHint, scale(n, dot(upHint, n)));
  const v = Math.hypot(...projected) < 1e-6 ? anyPerpendicular(n) : normalize(projected);
  return { origin, u: cross(n, v), v, n };
};

export const toWorld = (f: TunnelFrame, [x, y, z]: Vec3): Vec3 =>
  add(add(add(f.origin, scale(f.u, x)), scale(f.v, y)), scale(f.n, z));

/** World position of depth s on the tunnel's helix. */
export const tunnelPoint = (f: TunnelFrame, s: number): Vec3 => toWorld(f, helixLocal(s));
