// Speed-of-light sanity check on measured locations. Pure: the reducer keeps
// the agent's data as sent; checkLocations derives what the views should show,
// with implausible locations dropped so they are re-estimated like any hop
// without one.
import { angularDistance, latLonToVec3, type Vec3 } from "./geo";
import type { Destination, Hop, Probe } from "./protocol";
import type { TraceState } from "./reducer";

/** Light in fibre covers ~200 km/ms one way: ~100 km per ms of round-trip time. */
export const KM_PER_MS_RTT = 100;
/** Absorbs geo-IP error at the origin. */
export const SLACK_KM = 500;
export const EARTH_KM = 6371;

/** A location the IP database gave that the reply delay rules out. */
export interface LocationDoubt {
  /** Where the database said it was (city), when it named one. */
  readonly place: string | null;
  /** The smallest reply delay the check used. */
  readonly rttMs: number;
}

/** What the views draw: the state with implausible locations dropped, and why. */
export interface ShownState extends TraceState {
  /** Keyed by hop ttl. */
  readonly doubts: ReadonlyMap<number, LocationDoubt>;
  readonly destinationDoubt: LocationDoubt | null;
}

/** The doubt fields, absent on a plain reducer state (consumers that only read them accept either). */
export type MaybeShown = TraceState & Partial<Pick<ShownState, "doubts" | "destinationDoubt">>;

/** True when `pos` is within what light can cover out and back in `minRttMs`, plus the slack. */
export const isPlausible = (originPos: Vec3, pos: Vec3, minRttMs: number): boolean =>
  angularDistance(originPos, pos) * EARTH_KM <= KM_PER_MS_RTT * minRttMs + SLACK_KM;

const MEASURED: ReadonlySet<string> = new Set(["api", "hostname"]);

const minRtt = (probes: readonly Probe[]): number | null =>
  probes.reduce<number | null>((m, p) => (p.rttMs === null || (m !== null && m <= p.rttMs) ? m : p.rttMs), null);

interface Geo { readonly lat: number | null; readonly lon: number | null }
const positionOf = (g: Geo): Vec3 | null => (g.lat === null || g.lon === null ? null : latLonToVec3(g.lat, g.lon));

/** The user's location: the agent's origin, else the first located hop (the layout's anchor). */
const originOf = (state: TraceState): Vec3 | null => {
  const fromOrigin = state.origin ? positionOf(state.origin) : null;
  if (fromOrigin) return fromOrigin;
  const first = state.hops.find((h) => positionOf(h) !== null);
  return first ? positionOf(first) : null;
};

const dropped = <T extends Geo & { city: string | null; geoSource: string }>(g: T): T =>
  ({ ...g, lat: null, lon: null, city: null, geoSource: "estimated" });

const doubtOf = (originPos: Vec3, g: Geo & { city: string | null; geoSource: string }, rtt: number | null): LocationDoubt | null => {
  const pos = positionOf(g);
  if (rtt === null || pos === null || !MEASURED.has(g.geoSource)) return null;
  return isPlausible(originPos, pos, rtt) ? null : { place: g.city, rttMs: rtt };
};

export const checkLocations = (state: TraceState): ShownState => {
  const none: ShownState = { ...state, doubts: new Map(), destinationDoubt: null };
  const originPos = originOf(state);
  if (originPos === null) return none;

  const checked = state.hops.map((h): { hop: Hop; doubt: LocationDoubt | null } => {
    const doubt = doubtOf(originPos, h, minRtt(h.probes));
    return { hop: doubt ? dropped(h) : h, doubt };
  });
  const d: Destination | null = state.destination;
  const destinationDoubt = d && d.reachable ? doubtOf(originPos, d, d.rttMs) : null;

  return {
    ...state,
    hops: checked.map((c) => c.hop),
    destination: d && destinationDoubt ? dropped(d) : d,
    doubts: new Map(checked.flatMap((c) => (c.doubt ? [[c.hop.ttl, c.doubt] as const] : []))),
    destinationDoubt,
  };
};
