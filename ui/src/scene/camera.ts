import { PerspectiveCamera } from "three";
import { angularDistance, type Vec3 } from "../geo";

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

/** Camera direction (unit, from globe centre) and distance framing the first and last points. */
export const frameTarget = (points: readonly Vec3[]): { dir: Vec3; distance: number } => {
  const first = points[0] ?? [0, 0, 1];
  const last = points[points.length - 1] ?? first;
  const sum: Vec3 = [first[0] + last[0], first[1] + last[1], first[2] + last[2]];
  const dir = Math.hypot(...sum) < 1e-6 ? last : norm(sum);
  const span = Math.max(...points.map((p) => angularDistance(dir, p)), 0);
  const t = Math.min(span / (Math.PI / 2), 1);
  return { dir, distance: NEAR_DISTANCE + (FAR_DISTANCE - NEAR_DISTANCE) * t };
};

/** Backs off on portrait viewports so the framed span fits the narrow width. */
export const fitDistance = (distance: number, aspect: number, fovDeg: number): number => {
  if (aspect >= 1) return distance;
  const vertical = Math.tan((fovDeg * Math.PI) / 360);
  return distance * Math.min(vertical / (vertical * aspect), 2.4) ** 0.8;
};

const OMEGA = 2.6;
const ELEVATION = 0.22; // look slightly down on the framed point

export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /** Ease toward framing these world points (origin first, newest last). Instant under reduced motion. */
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
      const lifted = norm([f.dir[0], f.dir[1] + ELEVATION, f.dir[2]]);
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
