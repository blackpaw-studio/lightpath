// Pure tunnel geometry: where each hop's gate sits along the helix, and the
// local frame anchoring the tunnel at the origin node (+z = inward normal).
import { meanRtt, NO_RTT_COLOR, rttColor } from "../color";
import { destinationTtl, sceneDestination } from "../destination";
import { add, cross, dot, normalize, scale, sub, type Vec3 } from "../geo";
import type { Hop } from "../protocol";
import { shortNetworkName } from "../hud/network";
import type { TraceState } from "../reducer";

/** Smallest gap between consecutive gates (world units). */
export const MIN_GAP = 0.6;
/** Extra gap per ms of RTT increase over the previous hop (a 60 ms ocean crossing adds 1.5). */
export const RTT_GAP_K = 0.025;
/** Most depth RTT may add over a whole route; past it every RTT gap scales down together. */
export const MAX_RTT_DEPTH = 8;
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
  /** Position not measured (the destination of a quiet finish): drawn like an estimated node. */
  readonly estimated: boolean;
}

/** Local tunnel frame, right-handed (u × v = n): v = screen up, n = inward normal (down the tunnel). */
export interface TunnelFrame {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
}

/**
 * Gate depths, ∝ RTT delta: s_i = s_{i-1} + MIN_GAP + k·max(0, rtt_i − rtt_{i-1}),
 * from the origin at s = 0 with RTT 0. A timeout (null) adds MIN_GAP and keeps
 * the last known RTT as the baseline for the next hop. When the RTT terms sum
 * past maxRttDepth, k shrinks so they sum to exactly that (proportions kept).
 */
export const gateSpacing = (
  rtts: readonly (number | null)[], minGap = MIN_GAP, k = RTT_GAP_K, maxRttDepth = MAX_RTT_DEPTH,
): number[] => {
  const deltas = rtts.reduce<{ base: number; out: number[] }>(({ base, out }, rtt) => (
    rtt === null ? { base, out: [...out, 0] } : { base: rtt, out: [...out, Math.max(0, rtt - base)] }
  ), { base: 0, out: [] }).out;
  const total = deltas.reduce((a, b) => a + b, 0);
  const kEff = total * k > maxRttDepth ? maxRttDepth / total : k;
  return deltas.reduce<number[]>((acc, d) => [...acc, (acc[acc.length - 1] ?? 0) + minGap + kEff * d], []);
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

/** Pure: reducer state → gates in ttl order, plus the estimated destination gate of a quiet finish. */
export const tunnelGates = (state: TraceState): TunnelGate[] => {
  const dest = sceneDestination(state);
  const rtts = [...state.hops.map((h) => meanRtt(h.probes)), ...(dest ? [dest.rttMs] : [])];
  const s = gateSpacing(rtts);
  const hopGates = state.hops.map((h, i): TunnelGate => {
    const broken = isTimeoutHop(h);
    return { ...gateLabel(h), s: s[i]!, broken, estimated: false, color: broken ? NO_RTT_COLOR : rttColor(rtts[i] ?? null) };
  });
  if (!dest) return hopGates;
  const net = shortNetworkName(dest.org, dest.asn);
  const delay = dest.rttMs === null ? null : `${dest.rttMs.toFixed(1)} ms`;
  return [...hopGates, {
    ttl: destinationTtl(state.hops), title: "Destination", detail: [net, delay].filter((x) => x !== null).join(" · "),
    s: s[hopGates.length]!, broken: false, estimated: true, color: dest.rttMs === null ? NO_RTT_COLOR : rttColor(dest.rttMs),
  }];
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
  return { origin, u: cross(v, n), v, n };
};

export const toWorld = (f: TunnelFrame, [x, y, z]: Vec3): Vec3 =>
  add(add(add(f.origin, scale(f.u, x)), scale(f.v, y)), scale(f.n, z));

/** World position of depth s on the tunnel's helix. */
export const tunnelPoint = (f: TunnelFrame, s: number): Vec3 => toWorld(f, helixLocal(s));

/** Unit tangent of the helix at depth s, in world space. */
export const tunnelTangent = (f: TunnelFrame, s: number): Vec3 => {
  const e = 1e-3;
  return normalize(sub(tunnelPoint(f, s + e), tunnelPoint(f, s - e)));
};
