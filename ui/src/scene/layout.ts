import { NO_RTT_COLOR, meanRtt, rttColor } from "../color";
import { estimatePosition, type LocatedHop } from "../estimate";
import { latLonToVec3, type Vec3 } from "../geo";
import type { Hop } from "../protocol";
import type { TraceState } from "../reducer";

/** Where and how a hop sits on the globe (unit sphere, globe-local space). */
export interface LaidHop {
  readonly ttl: number;
  readonly pos: Vec3;
  /** No geo from the agent; position interpolated by the UI. */
  readonly estimated: boolean;
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
  const anchors: LocatedHop[] = state.hops.filter(located).map((h) => ({ ttl: h.ttl, pos: latLonToVec3(h.lat, h.lon) }));
  const o = state.origin;
  const origin = o && o.lat !== null && o.lon !== null ? latLonToVec3(o.lat, o.lon) : (anchors[0]?.pos ?? fallbackOrigin);
  if (!origin) return { generation: state.generation, origin: null, hops: [] };
  const hops = state.hops.map((h): LaidHop => {
    const rttMs = meanRtt(h.probes);
    return {
      ttl: h.ttl,
      pos: located(h) ? latLonToVec3(h.lat, h.lon) : estimatePosition(h.ttl, anchors, origin),
      estimated: !located(h),
      timeout: h.probes.every((p) => p.rttMs === null),
      rttMs,
      color: rttMs === null ? NO_RTT_COLOR : rttColor(rttMs),
    };
  });
  return { generation: state.generation, origin, hops };
};
