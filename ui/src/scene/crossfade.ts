// Reduced-motion crossfade: snapshot the last frame into an overlay canvas, cut
// the camera, then fade the snapshot out over REDUCED_MS of virtual time.
import { REDUCED_MS } from "./transition";

export interface Crossfade {
  /** Copy `source` now (call right after rendering it, while its drawing buffer is valid). */
  capture(source: HTMLCanvasElement, nowMs: number): void;
  /** Advance the fade; returns the snapshot's current opacity (0 when idle). */
  update(nowMs: number): number;
  dispose(): void;
}

export const createCrossfade = (overlay: HTMLCanvasElement, durationMs = REDUCED_MS): Crossfade => {
  const ctx = overlay.getContext("2d");
  let start: number | null = null;
  const setOpacity = (o: number): void => {
    overlay.style.opacity = String(o);
    overlay.style.visibility = o > 0 ? "visible" : "hidden";
  };
  setOpacity(0);
  return {
    capture: (source, nowMs) => {
      if (!ctx) return;
      if (overlay.width !== source.width || overlay.height !== source.height) {
        overlay.width = source.width;
        overlay.height = source.height;
      }
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.drawImage(source, 0, 0);
      start = nowMs;
      setOpacity(1);
    },
    update: (nowMs) => {
      if (start === null) return 0;
      const o = Math.max(0, 1 - (nowMs - start) / durationMs);
      setOpacity(o);
      if (o === 0) start = null;
      return o;
    },
    dispose: () => setOpacity(0),
  };
};
