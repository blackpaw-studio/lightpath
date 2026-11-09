import type { Destination, Hop } from "./protocol";
import type { TraceState } from "./reducer";

/** The scene's id for the destination entry: one past the last hop's ttl. */
export const destinationTtl = (hops: readonly Hop[]): number => Math.max(0, ...hops.map((h) => h.ttl)) + 1;

/**
 * The destination to draw in the scene: only a finished trace that stopped early
 * (quiet) and whose destination has a location, whether or not it answered over TCP
 * (an unanswering one is placed from its IP location alone). Otherwise null, and the
 * scene shows the path as it was measured.
 */
export const sceneDestination = (state: TraceState): Destination | null => {
  const d = state.destination;
  if (state.status !== "done" || state.endReason !== "quiet" || d === null) return null;
  return d.lat !== null && d.lon !== null ? d : null;
};
