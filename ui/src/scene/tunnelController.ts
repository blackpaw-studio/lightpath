// Headless brain of the globe ↔ tunnel views: transition timeline, tunnel
// anchoring, focus along the spline, and the single per-frame pose source.
// No three.js rendering here, so tests can drive it frame by frame.
import { normalize, scale, type Vec3 } from "../geo";
import type { TraceState } from "../reducer";
import { fitDistance, FOV_DEG, springStep, type SpringState } from "./camera";
import { ORIGIN_KEY, type PoseMap, type PoseSource } from "./globePoses";
import { createTunnelPoseSource } from "./poses";
import {
  cameraAt, focusDepth, globeTransition, layerFades, modeOf, northUpSafe, reducedCameraAt, reducedShot, rigUp, rotateBetween, S_HOME, T_SURFACE,
  startTransition, stepTransition, viewTOf, type CameraPose, type LayerFades, type Transition, type ViewMode,
} from "./transition";
import { tunnelFrame, tunnelGates, type TunnelFrame, type TunnelGate } from "./tunnelLayout";

/** Spring rate for gliding the tunnel camera between gates (rad/s, critically damped). */
export const FOCUS_OMEGA = 3.2;
/** Surfacing waits until the camera is this close to its home depth before the flight starts. */
export const SURFACE_HANDOFF = 0.25;

export interface TunnelControllerDeps {
  /** The globe's own pose source (createGlobePoseSource). */
  readonly globeSource: PoseSource;
  /** Live globe rig camera position; the rig always looks at the globe centre. */
  readonly rigPos: () => Vec3;
  /** Viewport aspect (width / height); sets the swing distance that keeps the whole globe in frame. */
  readonly aspect: () => number;
  readonly reducedMotion: boolean;
}

export interface TunnelController {
  /** Install on the globe view; called exactly once per frame inside its update. */
  readonly poseSource: PoseSource;
  setState(state: TraceState): void;
  /** Advance the transition one frame. Call before the globe view updates. */
  advance(dtMs: number): void;
  /** This frame's camera. Call after the globe rig has updated. */
  camera(): CameraPose;
  fades(): LayerFades;
  mode(): ViewMode;
  viewT(): number;
  /** The camera cut this frame (reduced motion: crossfade it). */
  cut(): boolean;
  /** Start (or reverse into) a dive. False when there is no origin to dive into. */
  dive(): boolean;
  surface(): void;
  /** Glide the tunnel camera to a gate (ttl 0 = the mouth). False outside the tunnel or for an unknown hop. */
  focusHop(ttl: number): boolean;
  frame(): TunnelFrame | null;
  gates(): readonly TunnelGate[];
  depths(): ReadonlyMap<number, number>;
  poses(): PoseMap;
}

interface Anchor {
  readonly frame: TunnelFrame;
  readonly northUp: boolean;
}

/** North stays up into the tunnel when it can; near a pole the rig's roll is carried down instead. */
const anchorFrame = (origin: Vec3, rigPos: Vec3): Anchor => {
  if (northUpSafe(rigPos, origin)) return { frame: tunnelFrame(origin, [0, 1, 0]), northUp: true };
  const f0 = normalize(scale(rigPos, -1));
  return { frame: tunnelFrame(origin, rotateBetween(f0, scale(origin, -1), rigUp(f0))), northUp: false };
};

export const createTunnelController = (deps: TunnelControllerDeps): TunnelController => {
  let transition: Transition = globeTransition;
  let frame: TunnelFrame | null = null;
  let northUp = true;
  let state: TraceState | null = null;
  let gates: readonly TunnelGate[] = [];
  let poses: PoseMap = new Map();
  let cam: SpringState = { x: S_HOME, v: 0 };
  let camGoal = S_HOME;
  let cut = false;

  const tunnel = createTunnelPoseSource(deps.globeSource, () => ({ viewT: viewTOf(transition), frame, gates }));
  const mode = (): ViewMode => modeOf(transition);
  /** Identity of the reduced-motion shot; a change between frames is a camera cut. */
  const shotKey = (): string => {
    if (!deps.reducedMotion) return "flight";
    const shot = reducedShot(transition);
    return shot === "tunnel" ? `tunnel@${cam.x}` : shot;
  };
  let lastShot = shotKey();

  const advanceCamera = (dtMs: number): void => {
    // Until the camera crosses the surface it is not on the spline yet: hold it
    // at home and keep any focus goal for when it is (a focus during an early
    // dive would otherwise be crammed into the last tenth of the flight).
    if (viewTOf(transition) < T_SURFACE) {
      cam = { x: S_HOME, v: 0 };
      return;
    }
    // Surfacing pulls the camera home along the spline while the flight plays.
    const goal = mode() === "surfacing" ? S_HOME : camGoal;
    cam = deps.reducedMotion ? { x: goal, v: 0 } : springStep(cam, goal, dtMs, FOCUS_OMEGA);
  };

  /** Surfacing from deep in the tunnel first glides back toward the mouth, then the flight starts. */
  const holdingForReturn = (): boolean =>
    !deps.reducedMotion && transition.target === 0 && transition.progress >= 1 && cam.x > S_HOME + SURFACE_HANDOFF;

  return {
    poseSource: (input) => (poses = tunnel.source(input)),
    setState: (s) => {
      if (s === state) return;
      // A new trace restarts the gates near the mouth; glide the camera back there
      // along the spline rather than leaving it deep in an empty tube.
      if (state && s.generation !== state.generation) camGoal = S_HOME;
      state = s;
      gates = tunnelGates(s);
    },
    advance: (dtMs) => {
      if (!holdingForReturn()) transition = stepTransition(transition, dtMs);
      advanceCamera(dtMs);
      const key = shotKey();
      cut = key !== lastShot;
      lastShot = key;
    },
    camera: () => {
      const rigPos = deps.rigPos();
      const orbitR = fitDistance([Math.PI / 2], deps.aspect(), FOV_DEG);
      if (!frame) return cameraAt(0, { rigPos, orbitR, ...anchorFrame([0, 0, 1], rigPos), camS: S_HOME });
      const input = { rigPos, orbitR, frame, northUp, camS: cam.x };
      return deps.reducedMotion ? reducedCameraAt(reducedShot(transition), input) : cameraAt(viewTOf(transition), input);
    },
    fades: () => layerFades(viewTOf(transition)),
    mode,
    viewT: () => viewTOf(transition),
    cut: () => cut,
    dive: () => {
      if (mode() === "globe") {
        const origin = poses.get(ORIGIN_KEY)?.pos;
        if (!origin) return false;
        ({ frame, northUp } = anchorFrame(origin, deps.rigPos()));
        cam = { x: S_HOME, v: 0 };
        camGoal = S_HOME;
      }
      transition = startTransition(transition, 1);
      return true;
    },
    surface: () => {
      camGoal = S_HOME;
      transition = startTransition(transition, 0);
    },
    focusHop: (ttl) => {
      const m = mode();
      const s = tunnel.depths().get(ttl);
      if ((m !== "tunnel" && m !== "diving") || s === undefined) return false;
      camGoal = ttl === ORIGIN_KEY ? S_HOME : focusDepth(s);
      return true;
    },
    frame: () => frame,
    gates: () => gates,
    depths: () => tunnel.depths(),
    poses: () => poses,
  };
};
