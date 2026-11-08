// Globe ↔ tunnel transition: a pure viewT timeline plus one continuous camera
// curve (position, look-at, roll, FOV) as a function of viewT. Dive plays
// viewT 0→1, Surface plays the same curves 1→0.
import { add, cross, dot, lerp3, normalize, scale, slerpGreatCircle, sub, type Vec3 } from "../geo";
import { FOV_DEG } from "./camera";
import { easeInOutCubic, hermite, smoothstep } from "./easing";
import { helixLocal, toWorld, tunnelPoint, type TunnelFrame } from "./tunnelLayout";

export { easeInOutCubic } from "./easing";

export const DIVE_MS = 2400;
/** Reduced motion: no flight; a crossfade this long while poses still move continuously. */
export const REDUCED_MS = 400;
export const TUNNEL_FOV = 58;
/** Camera depth at the end of a dive: just past the origin node, framing hop 1's gate. */
export const S_HOME = 0.1;
/** Focusing a gate parks the camera this far in front of it. */
export const FOCUS_BACK = 0.5;
export const LOOK_AHEAD = 1.4;
/** viewT at which the camera passes through the origin node into the tunnel. */
export const T_SURFACE = 0.9;
/** Camera speed (world units per unit viewT) when it crosses the surface. */
const ENTRY_SPEED = 1;
const SWING_RADIUS = 1.55;
const SKIM_RADIUS = 1.12;
const SNAP = 1e-9;

export type ViewMode = "globe" | "diving" | "tunnel" | "surfacing";
export type ViewTarget = 0 | 1;

export interface Transition {
  /** Linear time fraction of the current run, 0 (globe) … 1 (tunnel). */
  readonly progress: number;
  readonly target: ViewTarget;
  /** This run uses the reduced-motion timing and camera cut. */
  readonly reduced: boolean;
  /** The camera cuts on this frame (reduced motion only). */
  readonly cut: boolean;
  readonly cutPending: boolean;
}

export const globeTransition: Transition = { progress: 0, target: 0, reduced: false, cut: false, cutPending: false };

export const startTransition = (t: Transition, target: ViewTarget, reduced: boolean): Transition =>
  t.target === target ? t : { ...t, target, reduced, cutPending: reduced };

export const stepTransition = (t: Transition, dtMs: number): Transition => {
  const rate = Math.max(dtMs, 0) / (t.reduced ? REDUCED_MS : DIVE_MS);
  const raw = t.progress + (t.target === 1 ? rate : -rate);
  const progress = raw >= 1 - SNAP ? 1 : raw <= SNAP ? 0 : raw;
  return { ...t, progress, cut: t.cutPending, cutPending: false };
};

export const viewTOf = (t: Transition): number => easeInOutCubic(t.progress);

export const modeOf = (t: Transition): ViewMode => {
  if (t.target === 1) return t.progress >= 1 ? "tunnel" : "diving";
  return t.progress <= 0 ? "globe" : "surfacing";
};

export const focusDepth = (gateS: number): number => Math.max(gateS - FOCUS_BACK, S_HOME);

/** Minimal rotation taking unit `a` onto unit `b`, applied to `x` (Rodrigues). */
export const rotateBetween = (a: Vec3, b: Vec3, x: Vec3): Vec3 => {
  const k = cross(a, b);
  const s = Math.hypot(...k);
  const c = dot(a, b);
  if (s < 1e-12) {
    if (c > 0) return x;
    const perp = normalize(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    return sub(scale(perp, 2 * dot(perp, x)), x);
  }
  const kh = scale(k, 1 / s);
  return add(add(scale(x, c), scale(cross(kh, x), s)), scale(kh, dot(kh, x) * (1 - c)));
};

/** Up vector of a camera looking along `fwd` with world +y up (the globe rig's convention). */
export const rigUp = (fwd: Vec3): Vec3 => normalize(sub([0, 1, 0], scale(fwd, fwd[1])));

export interface CameraInput {
  /** Live globe rig camera position (it always looks at the globe centre). */
  readonly rigPos: Vec3;
  readonly frame: TunnelFrame;
  /** Camera depth along the tunnel while in it. */
  readonly camS: number;
}

export interface CameraPose {
  readonly pos: Vec3;
  readonly look: Vec3;
  readonly up: Vec3;
  readonly fovDeg: number;
}

interface Key {
  readonly t: number;
  readonly p: Vec3;
}

/** Non-uniform Catmull-Rom (Hermite) through keys, with explicit end tangents. */
const hermite3 = (keys: readonly Key[], m0: Vec3, mEnd: Vec3, t: number): Vec3 => {
  const i = Math.min(Math.max(keys.findIndex((k, j) => j > 0 && t <= k.t) - 1, 0), keys.length - 2);
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const tangent = (j: number): Vec3 => {
    if (j === 0) return m0;
    if (j === keys.length - 1) return mEnd;
    const prev = keys[j - 1]!;
    const next = keys[j + 1]!;
    return scale(sub(next.p, prev.p), 1 / (next.t - prev.t));
  };
  const h = b.t - a.t;
  const ma = scale(tangent(i), h);
  const mb = scale(tangent(i + 1), h);
  const u = (t - a.t) / h;
  return [0, 1, 2].map((c) => hermite(a.p[c]!, b.p[c]!, ma[c]!, mb[c]!, u)) as unknown as Vec3;
};

const len = (v: Vec3): number => Math.hypot(...v);

/** Flight keys from the rig pose to the origin node: swing over, hover, skim, enter. */
const flightKeys = (rigPos: Vec3, origin: Vec3): Key[] => {
  const r = len(rigPos);
  const swingDir = slerpGreatCircle(scale(rigPos, 1 / r), origin, 0.5);
  return [
    { t: 0, p: rigPos },
    { t: 0.22, p: scale(swingDir, r + (SWING_RADIUS - r) * 0.45) },
    { t: 0.45, p: scale(origin, SWING_RADIUS) },
    { t: 0.76, p: scale(origin, SKIM_RADIUS) },
    { t: T_SURFACE, p: origin },
  ];
};

/** Depth along the tunnel after the surface crossing; 0 before it. */
const tunnelDepth = (viewT: number, camS: number): number => {
  if (viewT <= T_SURFACE) return 0;
  const u = (viewT - T_SURFACE) / (1 - T_SURFACE);
  return hermite(0, camS, ENTRY_SPEED * (1 - T_SURFACE), 0, u);
};

/** Camera pose at viewT ∈ [0,1]: 0 is exactly the globe rig, 1 is the tunnel camera at camS. */
export const cameraAt = (viewT: number, { rigPos, frame, camS }: CameraInput): CameraPose => {
  const sCam = tunnelDepth(viewT, camS);
  const keys = flightKeys(rigPos, frame.origin);
  const first = keys[1]!;
  const pos = viewT > T_SURFACE
    ? tunnelPoint(frame, sCam)
    : hermite3(keys, scale(sub(first.p, rigPos), 1 / first.t), scale(frame.n, ENTRY_SPEED), viewT);

  // Look target slides from the globe centre (= origin + n·1) down the tunnel axis onto the helix.
  const w = smoothstep(0.45, 1, viewT);
  const sLook = 1 + (sCam + LOOK_AHEAD - 1) * w;
  const helix = helixLocal(sLook);
  const look = toWorld(frame, [helix[0] * w, helix[1] * w, sLook]);

  // Roll: the rig's world-up convention near the globe, the tunnel frame's v
  // (carried by the minimal rotation from n to the view direction) elsewhere.
  const fwd = normalize(sub(look, pos));
  const blended = lerp3(rigUp(fwd), rotateBetween(frame.n, fwd, frame.v), smoothstep(0, 0.15, viewT));
  const up = normalize(sub(blended, scale(fwd, dot(blended, fwd))));
  return { pos, look, up, fovDeg: FOV_DEG + (TUNNEL_FOV - FOV_DEG) * smoothstep(0.55, 1, viewT) };
};

export interface LayerFades {
  readonly surface: number;
  readonly dots: number;
  readonly atmosphere: number;
  readonly arcs: number;
  /** 0 closed … 1 fully open portal in the globe at the origin node. */
  readonly aperture: number;
  readonly tunnel: number;
  readonly gates: number;
  readonly labels: number;
}

/** Opacity of each layer at viewT (plan §G: globe 0.5→0.9 out, gates/tunnel 0.4→0.8 in, labels 0.8→1). */
export const layerFades = (viewT: number): LayerFades => {
  const globe = 1 - smoothstep(0.5, T_SURFACE, viewT);
  return {
    surface: globe,
    dots: globe,
    atmosphere: 1 - smoothstep(0.25, 0.6, viewT),
    arcs: 1 - smoothstep(0.15, 0.45, viewT),
    aperture: smoothstep(0.3, 0.8, viewT),
    tunnel: smoothstep(0.4, 0.8, viewT),
    gates: smoothstep(0.4, 0.8, viewT),
    labels: smoothstep(0.8, 1, viewT),
  };
};
