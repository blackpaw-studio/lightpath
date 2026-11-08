export type Vec3 = readonly [number, number, number];

const RAD = Math.PI / 180;
const EPS = 1e-9;
/** Arc altitude per radian of angular distance. */
export const DEFAULT_ARC_K = 0.25;

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Exact at both ends (t = 0 → a, t = 1 → b). */
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];

/** Lat/lon in degrees → point on the unit sphere (y up, lon 0 along +x, east toward −z). */
export const latLonToVec3 = (latDeg: number, lonDeg: number): Vec3 => {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
};

export const angularDistance = (a: Vec3, b: Vec3): number =>
  Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

/** Unit vector perpendicular to `a`, chosen deterministically. */
const perpendicular = (a: Vec3): Vec3 => normalize(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));

/** Great-circle interpolation of unit vectors; endpoints are returned exactly. */
export const slerpGreatCircle = (a: Vec3, b: Vec3, t: number): Vec3 => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const theta = angularDistance(a, b);
  if (theta < EPS) return a;
  // Direction in the great-circle plane, orthogonal to `a`. Antipodal points
  // define no plane, so fall back to a fixed perpendicular axis.
  const u = Math.PI - theta < EPS ? perpendicular(a) : normalize(add(b, scale(a, -dot(a, b))));
  const phi = t * theta;
  return add(scale(a, Math.cos(phi)), scale(u, Math.sin(phi)));
};

/** n+1 points along the great circle a→b, lifted to radius 1 + k·θ·sin(πt). */
export const arcPoints = (a: Vec3, b: Vec3, n: number, k: number = DEFAULT_ARC_K): Vec3[] => {
  const h = k * angularDistance(a, b);
  const segments = Math.max(1, Math.floor(n));
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    return scale(slerpGreatCircle(a, b, t), 1 + h * Math.sin(Math.PI * t));
  });
};
