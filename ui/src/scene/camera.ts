import { PerspectiveCamera } from "three";
import { angularDistance, latLonToVec3, slerpGreatCircle, type Vec3 } from "../geo";

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
const MAX_DISTANCE = 12;
/** Framed points stay within this fraction of the narrower half-FOV. */
const FIT_MARGIN = 0.85;
/** Angular radius used when nothing is framed: the whole globe. */
const IDLE_SPAN = Math.PI / 2;

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

/** Narrower half-FOV (radians) shrunk by the fit margin. */
const fitHalfAngle = (aspect: number, fovDeg: number): number => {
  const vHalf = (fovDeg * Math.PI) / 360;
  return Math.min(vHalf, Math.atan(Math.tan(vHalf) * aspect)) * FIT_MARGIN;
};

/** True when unit-sphere point `p` faces a camera at `camPos` (looking at the centre) and sits inside the fit margin. */
export const inView = (camPos: readonly number[], p: Vec3, aspect: number, fovDeg: number): boolean => {
  const [cx = 0, cy = 0, cz = 0] = camPos;
  const d = Math.hypot(cx, cy, cz);
  if ((p[0] * cx + p[1] * cy + p[2] * cz) / d <= 1 / d) return false; // behind the horizon
  const rel: Vec3 = [p[0] - cx, p[1] - cy, p[2] - cz];
  const axis: Vec3 = [-cx, -cy, -cz];
  return angularDistance(rel, axis) <= fitHalfAngle(aspect, fovDeg) + 1e-9;
};

/**
 * Camera distance from the globe centre so unit-sphere points at the given
 * angles off the camera axis project inside the narrower half-FOV. Points
 * past the limb (> 90°) count as the limb.
 */
export const fitDistance = (angles: readonly number[], aspect: number, fovDeg: number): number => {
  const half = fitHalfAngle(aspect, fovDeg);
  const need = Math.max(...angles.map((a) => {
    const t = Math.min(a, Math.PI / 2);
    return Math.cos(t) + Math.sin(t) / Math.tan(half);
  }), NEAR_DISTANCE);
  return Math.min(need, MAX_DISTANCE);
};

const OMEGA = 2.6;
const ZOOM_OUT_BOOST = 2.5;
const ELEVATION = 0.12; // look slightly down on the framed point
const MAX_CAMERA_LAT = 50;

export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /** Ease toward framing these world points (the route: origin first, newest last), or jump there when `instant`. */
  frame(points: readonly Vec3[], instant: boolean): void;
  update(dtMs: number): void;
  resize(aspect: number): void;
}

/** Orbit rig: camera position is dir·distance, every component on its own critically damped spring. */
export const createCameraRig = (aspect: number): CameraRig => {
  const camera = new PerspectiveCamera(FOV_DEG, aspect, 0.01, 100);
  let currentAspect = aspect;
  let dir: Vec3 = norm([0.55, 0.5, 0.75]);
  // Angles of the framed points off `dir`; the goal distance is refit whenever the aspect changes.
  let angles: readonly number[] = [IDLE_SPAN];
  const goals = (): number[] => [...dir, fitDistance(angles, currentAspect, FOV_DEG)];
  let springs: SpringState[] = goals().map((x) => ({ x, v: 0 }));

  const apply = (): void => {
    const [x, y, z, d] = springs.map((s) => s.x) as [number, number, number, number];
    const n = norm([x, y, z]);
    camera.position.set(n[0] * d, n[1] * d, n[2] * d);
    camera.lookAt(0, 0, 0);
  };
  apply();

  return {
    camera,
    frame: (points, instant) => {
      const f = frameTarget(points);
      dir = clampLatitude(norm([f.dir[0], f.dir[1] + ELEVATION, f.dir[2]]), MAX_CAMERA_LAT);
      angles = points.length > 0 ? points.map((p) => angularDistance(dir, p)) : [IDLE_SPAN];
      if (instant) {
        springs = goals().map((x) => ({ x, v: 0 }));
        apply();
      }
    },
    update: (dtMs) => {
      const g = goals();
      // Zooming out outruns the pan so hops already in view never slide off-screen mid-move.
      springs = springs.map((s, i) => {
        const goal = g[i]!;
        const omega = i === 3 && goal > s.x ? OMEGA * ZOOM_OUT_BOOST : OMEGA;
        return springStep(s, goal, dtMs, omega);
      });
      apply();
    },
    resize: (a) => {
      currentAspect = a;
      camera.aspect = a;
      camera.updateProjectionMatrix();
      apply();
    },
  };
};

/**
 * Framing policy. Full motion: always ease to the new route. Reduced motion:
 * hold still while the newest point is in view; otherwise cut. Returns true
 * when a cut moved the camera (callers fade and mark the frame `cut`).
 */
export const applyFraming = (rig: CameraRig, points: readonly Vec3[], reducedMotion: boolean): boolean => {
  if (!reducedMotion) {
    rig.frame(points, false);
    return false;
  }
  const newest = points[points.length - 1];
  const cam = rig.camera;
  if (!newest || inView(cam.position.toArray(), newest, cam.aspect, cam.fov)) return false;
  const before = cam.position.clone();
  rig.frame(points, true);
  return !before.equals(cam.position);
};
