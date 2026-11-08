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

export const IDLE_DISTANCE = 3.7;
const NEAR_DISTANCE = 2.55;
const FAR_DISTANCE = 4.1;
export const FOV_DEG = 35;

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

/** Camera direction (unit, from globe centre) at the centre of the route's extent, and a distance fitting its span. */
export const frameTarget = (points: readonly Vec3[]): { dir: Vec3; distance: number } => {
  const last = points[points.length - 1] ?? [0, 0, 1];
  const sum = points.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  // A centroid near zero means the route wraps the globe; just look at the newest hop.
  const dir = Math.hypot(...sum) < 1e-6 * Math.max(points.length, 1) ? last : capCentre(points, norm(sum));
  const span = Math.max(...points.map((p) => angularDistance(dir, p)), 0);
  const t = Math.min(span / (Math.PI / 2), 1);
  return { dir, distance: NEAR_DISTANCE + (FAR_DISTANCE - NEAR_DISTANCE) * t };
};

/** Limits a direction's latitude (keeping longitude) so the camera never looks straight down a pole. */
export const clampLatitude = (dir: Vec3, maxDeg: number): Vec3 => {
  const lat = (Math.asin(Math.max(-1, Math.min(1, dir[1]))) * 180) / Math.PI;
  if (Math.abs(lat) <= maxDeg) return dir;
  const lon = (Math.atan2(-dir[2], dir[0]) * 180) / Math.PI;
  return latLonToVec3(Math.sign(lat) * maxDeg, lon);
};

/** Backs off on portrait viewports so the framed span fits the narrow width. */
export const fitDistance = (distance: number, aspect: number, fovDeg: number): number => {
  if (aspect >= 1) return distance;
  const vertical = Math.tan((fovDeg * Math.PI) / 360);
  return distance * Math.min(vertical / (vertical * aspect), 2.4) ** 0.8;
};

const OMEGA = 2.6;
const ELEVATION = 0.12; // look slightly down on the framed point
const MAX_CAMERA_LAT = 50;

export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /** Ease toward framing these world points (the route: origin first, newest last). Instant under reduced motion. */
  frame(points: readonly Vec3[], instant: boolean): void;
  update(dtMs: number): void;
  resize(aspect: number): void;
}

/** Orbit rig: camera position is dir·distance, every component on its own critically damped spring. */
export const createCameraRig = (aspect: number): CameraRig => {
  const camera = new PerspectiveCamera(FOV_DEG, aspect, 0.01, 100);
  let currentAspect = aspect;
  let target: { dir: Vec3; distance: number } = { dir: norm([0.55, 0.5, 0.75]), distance: IDLE_DISTANCE };
  let springs: SpringState[] = [...target.dir, target.distance].map((x) => ({ x, v: 0 }));

  const apply = (): void => {
    const [x, y, z, d] = springs.map((s) => s.x) as [number, number, number, number];
    const dir = norm([x, y, z]);
    const dist = fitDistance(d, currentAspect, FOV_DEG);
    camera.position.set(dir[0] * dist, dir[1] * dist, dir[2] * dist);
    camera.lookAt(0, 0, 0);
  };
  apply();

  return {
    camera,
    frame: (points, instant) => {
      const f = frameTarget(points);
      const lifted = clampLatitude(norm([f.dir[0], f.dir[1] + ELEVATION, f.dir[2]]), MAX_CAMERA_LAT);
      target = { dir: lifted, distance: f.distance };
      if (instant) springs = [...target.dir, target.distance].map((x) => ({ x, v: 0 }));
    },
    update: (dtMs) => {
      const goals = [...target.dir, target.distance];
      springs = springs.map((s, i) => springStep(s, goals[i]!, dtMs, OMEGA));
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
