// Globe ↔ tunnel transition: a pure viewT timeline plus one continuous camera
// curve (position, look-at, roll, FOV) as a function of viewT. Dive plays
// viewT 0→1, Surface plays the same curves 1→0.
import { add, cross, dot, latLonToVec3, lerp3, normalize, scale, sub, type Vec3 } from "../geo";
import { FOV_DEG } from "./camera";
import { easeInOutSine, hermite, smoothstep } from "./easing";
import { helixLocal, toWorld, tunnelPoint, type TunnelFrame } from "./tunnelLayout";

export { easeInOutSine } from "./easing";

export const DIVE_MS = 2400;
/**
 * Reduced motion: the camera does not fly. It cuts between fixed poses (see
 * reducedCameraAt), a crossfade this long masks each cut, and poses and fades
 * still play the normal timeline so every hop moves continuously.
 */
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
/** viewT at which the camera has swung over the origin and starts descending the axis. */
export const T_SWING = 0.38;
const T_SKIM = 0.7;
/** Altitude left at T_SKIM, as a fraction of the orbit altitude. */
const SKIM_FRACTION = 0.2;
const SNAP = 1e-9;
/** Largest |y| of a view direction for which "north up" is well defined (≈ 76° latitude). */
const NORTH_UP_LIMIT = 0.97;
/** viewT over which a north-up dive hands its roll to the tunnel frame. */
const ROLL_HANDOFF: readonly [number, number] = [0.4, 0.9];

export type ViewMode = "globe" | "diving" | "tunnel" | "surfacing";
export type ViewTarget = 0 | 1;

export interface Transition {
  /** Linear time fraction of the current run, 0 (globe) … 1 (tunnel). */
  readonly progress: number;
  readonly target: ViewTarget;
}

export const globeTransition: Transition = { progress: 0, target: 0 };

export const startTransition = (t: Transition, target: ViewTarget): Transition =>
  t.target === target ? t : { ...t, target };

/** Advance a run that takes `durationMs` end to end (reduced motion runs it in REDUCED_MS). */
export const stepTransition = (t: Transition, dtMs: number, durationMs = DIVE_MS): Transition => {
  const rate = Math.max(dtMs, 0) / durationMs;
  const raw = t.progress + (t.target === 1 ? rate : -rate);
  return { ...t, progress: raw >= 1 - SNAP ? 1 : raw <= SNAP ? 0 : raw };
};

export const viewTOf = (t: Transition): number => easeInOutSine(t.progress);

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
  /** Camera distance during the swing; at least the distance that frames the whole globe. */
  readonly orbitR: number;
  readonly frame: TunnelFrame;
  /** Camera depth along the tunnel while in it. */
  readonly camS: number;
  /**
   * Keep the globe's north up through the flight (frame.v must then be north
   * at the origin). Only valid when northUpSafe; otherwise the rig's roll is
   * carried along the flight by minimal rotation.
   */
  readonly northUp: boolean;
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

const DEG = 180 / Math.PI;
const latLonOf = (d: Vec3): readonly [number, number] => [Math.asin(Math.max(-1, Math.min(1, d[1]))) * DEG, Math.atan2(-d[2], d[0]) * DEG];

/** Direction between unit a and b, interpolating latitude and longitude (the shorter way round) so it never crosses a pole. */
const lerpLatLon = (a: Vec3, b: Vec3, t: number): Vec3 => {
  const [la, oa] = latLonOf(a);
  const [lb, ob] = latLonOf(b);
  const dLon = ((((ob - oa) % 360) + 540) % 360) - 180;
  return latLonToVec3(la + (lb - la) * t, oa + dLon * t);
};

/**
 * North-up roll is well defined over the whole dive when neither the rig nor
 * the origin is near a pole: the swing interpolates latitude between them.
 */
export const northUpSafe = (rigPos: Vec3, origin: Vec3): boolean =>
  Math.abs(normalize(rigPos)[1]) < NORTH_UP_LIMIT && Math.abs(normalize(origin)[1]) < NORTH_UP_LIMIT;

/**
 * Flight keys: rise to the orbit distance while swinging over the origin
 * (looking at the globe centre, so the whole globe stays in frame), then
 * descend straight down the tunnel axis onto the origin node.
 */
const flightKeys = (rigPos: Vec3, origin: Vec3, orbitR: number): Key[] => {
  const r = len(rigPos);
  const swingDir = lerpLatLon(scale(rigPos, 1 / r), origin, 0.45);
  return [
    { t: 0, p: rigPos },
    { t: T_SWING / 2, p: scale(swingDir, r + (orbitR - r) * 0.6) },
    { t: T_SWING, p: scale(origin, orbitR) },
    { t: T_SKIM, p: scale(origin, 1 + (orbitR - 1) * SKIM_FRACTION) },
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
export const cameraAt = (viewT: number, { rigPos, orbitR, frame, camS, northUp }: CameraInput): CameraPose => {
  const sCam = tunnelDepth(viewT, camS);
  const keys = flightKeys(rigPos, frame.origin, Math.max(orbitR, len(rigPos)));
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
  // (carried by the minimal rotation from n to the view direction) in the
  // tunnel. North-up keeps the rig's convention over the whole flight; the
  // fallback hands over at once and carries the rig's roll instead.
  const fwd = normalize(sub(look, pos));
  const handoff = northUp ? smoothstep(ROLL_HANDOFF[0], ROLL_HANDOFF[1], viewT) : smoothstep(0, 0.15, viewT);
  const blended = lerp3(rigUp(fwd), rotateBetween(frame.n, fwd, frame.v), handoff);
  const up = normalize(sub(blended, scale(fwd, dot(blended, fwd))));
  return { pos, look, up, fovDeg: FOV_DEG + (TUNNEL_FOV - FOV_DEG) * smoothstep(0.55, 1, viewT) };
};

export type ReducedShot = "globe" | "tunnel";

/**
 * Reduced-motion camera: no flight, only the two resting shots. It cuts to the
 * target's shot when a change starts (the scene crossfades the cut), and the
 * hops travel within that same short run.
 */
export const reducedShot = (t: Transition): ReducedShot => (t.target === 1 ? "tunnel" : "globe");

export const reducedCameraAt = (shot: ReducedShot, input: CameraInput): CameraPose =>
  cameraAt(shot === "globe" ? 0 : 1, input);

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
