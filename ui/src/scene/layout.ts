import { NO_RTT_COLOR, meanRtt, rttColor } from "../color";
import { destinationTtl, sceneDestination } from "../destination";
import { estimatePositions, type LocatedHop } from "../estimate";
import { minRtt } from "../plausibility";
import { latLonToVec3, type Vec3 } from "../geo";
import type { Hop } from "../protocol";
import type { TraceState } from "../reducer";

/** Where and how a hop sits on the globe (unit sphere, globe-local space). */
export interface LaidHop {
  readonly ttl: number;
  readonly pos: Vec3;
  /** No geo from the agent; position interpolated by the UI. */
  readonly estimated: boolean;
  /** Placed from a location (a located hop, or the destination), so later estimates are anchored to it. */
  readonly located: boolean;
  /** Every probe timed out. */
  readonly timeout: boolean;
  readonly rttMs: number | null;
  readonly color: string;
}

export interface GlobeLayout {
  /** Trace generation (TraceState.generation); a change means a new trace. */
  readonly generation: number;
  /** Real origin, else first located hop, else the caller's previously known origin; never fabricated. */
  readonly origin: Vec3 | null;
  readonly hops: readonly LaidHop[];
}

const located = (h: Hop): h is Hop & { lat: number; lon: number } => h.lat !== null && h.lon !== null;

/**
 * Pure: reducer state → globe positions/colours. `fallbackOrigin` (the last
 * real origin seen) anchors a trace whose origin has no geo yet. Without any
 * anchor, unlocated hops are left out rather than placed at (0,0).
 */
export const globeLayout = (state: TraceState, fallbackOrigin: Vec3 | null = null): GlobeLayout => {
  const anchors: LocatedHop[] = state.hops.filter(located).map((h) => ({ ttl: h.ttl, pos: latLonToVec3(h.lat, h.lon), rttMs: minRtt(h.probes) }));
  const o = state.origin;
  const origin = o && o.lat !== null && o.lon !== null ? latLonToVec3(o.lat, o.lon) : (anchors[0]?.pos ?? fallbackOrigin);
  if (!origin) return { generation: state.generation, origin: null, hops: [] };
  // A quiet finish whose destination answers: the destination joins the anchors, so the
  // trailing silent hops spread along the great circle toward it instead of piling up.
  const dest = sceneDestination(state);
  const destHop: LaidHop | null = dest && dest.lat !== null && dest.lon !== null ? {
    ttl: destinationTtl(state.hops), pos: latLonToVec3(dest.lat, dest.lon), estimated: true, located: true, timeout: false,
    rttMs: dest.rttMs, color: dest.rttMs === null ? NO_RTT_COLOR : rttColor(dest.rttMs),
  } : null;
  const estimationAnchors = destHop ? [...anchors, { ttl: destHop.ttl, pos: destHop.pos, rttMs: destHop.rttMs }] : anchors;
  const estimated = estimatePositions(
    state.hops.filter((h) => !located(h)).map((h) => ({ ttl: h.ttl, rttMs: minRtt(h.probes) })), estimationAnchors, origin,
  );
  const hops = state.hops.map((h): LaidHop => {
    const rttMs = meanRtt(h.probes);
    return {
      ttl: h.ttl,
      pos: located(h) ? latLonToVec3(h.lat, h.lon) : estimated.get(h.ttl)!,
      estimated: !located(h),
      located: located(h),
      timeout: h.probes.every((p) => p.rttMs === null),
      rttMs,
      color: rttMs === null ? NO_RTT_COLOR : rttColor(rttMs),
    };
  });
  return { generation: state.generation, origin, hops: destHop ? [...hops, destHop] : hops };
};
