// Motion limits for checkTrace over the globe ↔ tunnel transition, shared by the
// unit-level simulation, the dev capture script and the E2E transition spec.
import type { Frame } from "../invariants";
import { FLIGHT } from "./poses";
import { DIVE_MS } from "./transition";

/** Plan §S3.2: 48 px per 1/60 s frame at 1280 px width. */
export const MAX_JUMP_PX = 48;
export const FLICKER_WINDOW_MS = 1000;

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * Peak legitimate per-frame world move for a route: its longest hop flight
 * (globe frame → tunnel frame) at the steepest point of the eased flight —
 * smoothstep slope 1.5/window × sine-ease slope π/2 × one frame of DIVE_MS — plus 10 %.
 */
export const worldJumpBound = (globe: Frame, tunnel: Frame, frameMs = 1000 / 60): number => {
  const spans = Object.entries(globe.entities).flatMap(([k, e]) => {
    const t = tunnel.entities[k];
    return e.world && t?.world ? [dist(e.world, t.world)] : [];
  });
  return Math.max(0, ...spans) * (1.5 / (FLIGHT[1] - FLIGHT[0])) * (Math.PI / 2) * (frameMs / DIVE_MS) * 1.1;
};
