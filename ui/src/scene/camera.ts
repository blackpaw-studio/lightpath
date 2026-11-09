import { PerspectiveCamera, Vector3 } from "three";
import { angularDistance, cross, dot, latLonToVec3, slerpGreatCircle, type Vec3 } from "../geo";
import { rotateY } from "./globePoses";
import { FULL_NDC, type NdcRect } from "./safeArea";

export interface SpringState {
  readonly x: number;
  readonly v: number;
}

/** Exact critically damped spring step toward `target`; omega in rad/s, dt in ms. */
export const springStep = (s: SpringState, target: number, dtMs: number, omega: number): SpringState => {
  if (dtMs <= 0) return s;
  const t = dtMs / 1000;
  const y = s.x - target;
  const decay = Math.exp(-omega * t);
  const c = s.v + omega * y;
  return { x: target + (y + c * t) * decay, v: (s.v - omega * c * t) * decay };
};

export const FOV_DEG = 35;
const NEAR_DISTANCE = 2.45;
export const MAX_DISTANCE = 12;
/** Framed points stay within this fraction of the free area's half extents. */
export const FIT_MARGIN = 0.85;
/** A point must clear the horizon by this much (in camera distance) to count as facing the camera. */
const HORIZON_EPS = 0.02;
/** Floor on the free area's half extents, so a sliver never asks for an infinite distance. */
const MIN_HALF = 0.1;
const DEFAULT_DIR: Vec3 = [0.55, 0.5, 0.75];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

const CAP_ITERATIONS = 400;

/**
 * Approximate centre of the smallest spherical cap holding every point
 * (Bădoiu–Clarkson: step toward the farthest point by 1/(k+1)), so dense
 * clusters of hops do not pull the view off the route's extent.
 */
const capCentre = (points: readonly Vec3[], start: Vec3): Vec3 => {
  let c = start;
  for (let k = 1; k <= CAP_ITERATIONS; k++) {
    const far = points.reduce((f, p) => (angularDistance(c, p) > angularDistance(c, f) ? p : f), c);
    c = slerpGreatCircle(c, far, 1 / (k + 1));
  }
  return c;
};

/** Camera direction (unit, from globe centre) at the centre of the route's extent, plus its angular radius. */
export const frameTarget = (points: readonly Vec3[]): { dir: Vec3; span: number } => {
  const last = points[points.length - 1] ?? [0, 0, 1];
  const sum = points.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  // A centroid near zero means the route wraps the globe; just look at the newest hop.
  const dir = Math.hypot(...sum) < 1e-6 * Math.max(points.length, 1) ? last : capCentre(points, norm(sum));
  return { dir, span: Math.max(...points.map((p) => angularDistance(dir, p)), 0) };
};

/** Limits a direction's latitude (keeping longitude) so the camera never looks straight down a pole. */
export const clampLatitude = (dir: Vec3, maxDeg: number): Vec3 => {
  const lat = (Math.asin(Math.max(-1, Math.min(1, dir[1]))) * 180) / Math.PI;
  if (Math.abs(lat) <= maxDeg) return dir;
  const lon = (Math.atan2(-dir[2], dir[0]) * 180) / Math.PI;
  return latLonToVec3(Math.sign(lat) * maxDeg, lon);
};

/** Camera basis for a camera at dir·d looking at the globe centre with +y up (as PerspectiveCamera.lookAt). */
const basis = (dir: Vec3): { right: Vec3; up: Vec3 } => {
  const c = cross([-dir[0], -dir[1], -dir[2]], [0, 1, 0]);
  const right = Math.hypot(...c) < 1e-6 ? ([1, 0, 0] as Vec3) : norm(c);
  return { right, up: cross(dir, right) };
};

/**
 * Smallest camera distance along `dir` at which every unit-sphere point faces the
 * camera and projects inside the free area `rect` (shrunk by FIT_MARGIN), given
 * the projection is shifted so the globe centre lands on the rect's centre.
 * Null when some point is on or past the horizon of `dir`, or the fit would need
 * more than MAX_DISTANCE.
 */
export const fitInRect = (points: readonly Vec3[], dir: Vec3, aspect: number, fovDeg: number, rect: NdcRect): number | null => {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  const hx = Math.max(rect.hx, MIN_HALF) * FIT_MARGIN;
  const hy = Math.max(rect.hy, MIN_HALF) * FIT_MARGIN;
  const { right, up } = basis(dir);
  let need = NEAR_DISTANCE;
  for (const p of points) {
    const f = dot(p, dir);
    if (f <= 0) return null;
    need = Math.max(need, 1 / f + HORIZON_EPS, f + Math.abs(dot(p, right)) / (tanH * hx), f + Math.abs(dot(p, up)) / (tanV * hy));
  }
  return need > MAX_DISTANCE ? null : need;
};

const ELEVATION = 0.12; // look slightly down on the framed point
const MAX_CAMERA_LAT = 50;

/** The view direction for a framing centre: nudged to look slightly down, latitude-clamped. */
const lookFrom = (centre: Vec3): Vec3 => clampLatitude(norm([centre[0], centre[1] + ELEVATION, centre[2]]), MAX_CAMERA_LAT);

/** Distance at which the whole globe fits the free area (the limb inside the narrower half-FOV, with the fit margin). */
const idleDistance = (aspect: number, fovDeg: number, rect: NdcRect): number => {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const half = Math.min(Math.atan(tanV * Math.max(rect.hy, MIN_HALF)), Math.atan(tanV * aspect * Math.max(rect.hx, MIN_HALF))) * FIT_MARGIN;
  return Math.min(Math.max(1 / Math.tan(half), NEAR_DISTANCE), MAX_DISTANCE);
};

/** Orbit radius at which the whole globe fits the full screen (the tunnel transition's home shot). */
export const limbDistance = (aspect: number, fovDeg: number): number => idleDistance(aspect, fovDeg, FULL_NDC);

/**
 * Pure framing target (globe-local frame) for a route: the direction at the
 * centre of its extent and the distance that fits every point in the free area.
 * A path too wide for that centres on the great-circle midpoint of its first and
 * last point at the maximum distance, so both ends stay on the visible hemisphere
 * wherever geometry allows. No points: the whole globe.
 */
export const solveFraming = (
  points: readonly Vec3[], aspect: number, fovDeg: number, rect: NdcRect,
): { dir: Vec3; dist: number } => {
  if (points.length === 0) return { dir: norm(DEFAULT_DIR), dist: idleDistance(aspect, fovDeg, rect) };
  const extent = frameTarget(points).dir;
  const dir = lookFrom(extent);
  const dist = fitInRect(points, dir, aspect, fovDeg, rect);
  if (dist !== null) return { dir, dist };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const antipodal = Math.PI - angularDistance(first, last) < 1e-6;
  return { dir: lookFrom(antipodal ? extent : slerpGreatCircle(first, last, 0.5)), dist: MAX_DISTANCE };
};

const OMEGA = 2.6;
const ZOOM_OUT_BOOST = 2.5;
const DIST_INDEX = 3;
const OFFSET_EPS = 1e-9;

/**
 * Shifts the camera's projection so the point it looks at lands at (cx, cy) in NDC.
 * Uses the camera's view offset, which survives updateProjectionMatrix (the tunnel
 * flight changes the fov every frame).
 */
const setCentreOffset = (camera: PerspectiveCamera, cx: number, cy: number): void => {
  if (Math.abs(cx) < OFFSET_EPS && Math.abs(cy) < OFFSET_EPS) {
    if (camera.view?.enabled) camera.clearViewOffset();
    return;
  }
  // The full size must keep the camera's aspect (three derives the frustum width from it).
  const a = camera.aspect;
  camera.setViewOffset(2 * a, 2, -cx * a, cy, 2 * a, 2);
};

export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /** Ease toward framing these globe-local points (the route: origin first, newest last), or jump there when `instant`. */
  frame(points: readonly Vec3[], instant: boolean): void;
  /** The part of the screen the globe may use (the viewport minus the HUD panels). A change re-targets the springs, or cuts when `instant`. */
  setSafeRect(rect: NdcRect, instant: boolean): void;
  /** The globe's idle rotation about +y: the framing turns with it so the route stays framed. */
  setYaw(radians: number): void;
  /** Scales the projection offset (1 = full, 0 = none; the tunnel retires it). */
  setOffsetScale(scale: number): void;
  /** True when every world point faces the camera and sits inside the free area, with the fit margin. */
  contains(worldPoints: readonly Vec3[]): boolean;
  update(dtMs: number): void;
  resize(aspect: number): void;
}

/** Orbit rig: camera position is dir·distance and the projection offset, every component on its own critically damped spring. */
export const createCameraRig = (aspect: number): CameraRig => {
  const camera = new PerspectiveCamera(FOV_DEG, aspect, 0.01, 100);
  let currentAspect = aspect;
  let rect: NdcRect = FULL_NDC;
  let yaw = 0;
  let offsetScale = 1;
  let points: readonly Vec3[] = [];
  let solved = solveFraming(points, currentAspect, FOV_DEG, rect);
  const solve = (): void => {
    solved = solveFraming(points, currentAspect, FOV_DEG, rect);
  };
  const goals = (): number[] => [...rotateY(solved.dir, yaw), solved.dist, rect.cx, rect.cy];
  let springs: SpringState[] = goals().map((x) => ({ x, v: 0 }));
  const snap = (): void => {
    springs = goals().map((x) => ({ x, v: 0 }));
  };

  const apply = (): void => {
    const [x, y, z, d, cx, cy] = springs.map((s) => s.x) as [number, number, number, number, number, number];
    const n = norm([x, y, z]);
    camera.position.set(n[0] * d, n[1] * d, n[2] * d);
    camera.lookAt(0, 0, 0);
    setCentreOffset(camera, cx * offsetScale, cy * offsetScale);
    camera.updateMatrixWorld(true);
  };
  apply();

  const scratch = new Vector3();
  return {
    camera,
    frame: (pts, instant) => {
      points = pts;
      solve();
      if (instant) {
        snap();
        apply();
      }
    },
    setSafeRect: (r, instant) => {
      rect = r;
      solve();
      if (instant) snap();
      apply();
    },
    setYaw: (radians) => { yaw = radians; },
    setOffsetScale: (scale) => { offsetScale = scale; },
    contains: (world) => {
      camera.updateMatrixWorld(true);
      const c = camera.position;
      return world.every((p) => {
        if (p[0] * c.x + p[1] * c.y + p[2] * c.z <= 1) return false; // behind the horizon
        scratch.set(...p).project(camera);
        const cx = rect.cx * offsetScale;
        const cy = rect.cy * offsetScale;
        return Math.abs(scratch.x - cx) <= rect.hx * FIT_MARGIN + 1e-9 && Math.abs(scratch.y - cy) <= rect.hy * FIT_MARGIN + 1e-9;
      });
    },
    update: (dtMs) => {
      const g = goals();
      // Zooming out outruns the pan so hops already in view never slide off-screen mid-move.
      springs = springs.map((s, i) => {
        const goal = g[i]!;
        const omega = i === DIST_INDEX && goal > s.x ? OMEGA * ZOOM_OUT_BOOST : OMEGA;
        return springStep(s, goal, dtMs, omega);
      });
      apply();
    },
    resize: (a) => {
      currentAspect = a;
      camera.aspect = a;
      camera.updateProjectionMatrix();
      solve();
      apply();
    },
  };
};

/**
 * Framing policy. Full motion: always ease to the new route. Reduced motion:
 * hold still while every point is in the free area; otherwise cut. Returns true
 * when a cut moved the camera (callers fade and mark the frame `cut`).
 * `points` are globe-local; `worldPoints` the same points as drawn (rotated).
 */
export const applyFraming = (
  rig: CameraRig, points: readonly Vec3[], reducedMotion: boolean, worldPoints: readonly Vec3[] = points,
): boolean => {
  if (!reducedMotion) {
    rig.frame(points, false);
    return false;
  }
  if (points.length === 0 || rig.contains(worldPoints)) return false;
  const before = rig.camera.position.clone();
  rig.frame(points, true);
  return !before.equals(rig.camera.position);
};
