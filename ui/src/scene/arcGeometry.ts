// Allocation-free twin of geo.arcPoints for per-frame arc rebuilds: writes
// n+1 points into a caller-owned buffer. Endpoints may sit off the unit
// sphere; the radius is blended linearly between them.
import { DEFAULT_ARC_K, type Vec3 } from "../geo";

const EPS = 1e-9;

/**
 * This arc is a piece of a longer run of hops on one great circle: its altitude
 * follows the run's single hump (sin over [t0, t1] of the run) instead of a hump
 * of its own, so chained arcs read as one smooth curve. `theta` is the run's
 * full angular length.
 */
export interface ArcSpan {
  readonly t0: number;
  readonly t1: number;
  readonly theta: number;
}

export const writeArcPoints = (
  out: Float32Array, a: Vec3, b: Vec3, n: number, k: number = DEFAULT_ARC_K, span?: ArcSpan,
): void => {
  const ra = Math.hypot(a[0], a[1], a[2]);
  const rb = Math.hypot(b[0], b[1], b[2]);
  const ax = a[0] / ra, ay = a[1] / ra, az = a[2] / ra;
  const bx = b[0] / rb, by = b[1] / rb, bz = b[2] / rb;
  const d = ax * bx + ay * by + az * bz;
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const theta = Math.atan2(Math.hypot(cx, cy, cz), d);
  const h = k * (span ? span.theta : theta);

  // Direction in the great-circle plane orthogonal to a; antipodal → fixed perpendicular (as geo.ts).
  let ux: number, uy: number, uz: number;
  if (Math.PI - theta < EPS) {
    const [px, py, pz] = Math.abs(ay) < 0.9 ? [-az, 0, ax] : [0, az, -ay]; // a × (0,1,0) or a × (1,0,0)
    const l = Math.hypot(px, py, pz);
    ux = px / l; uy = py / l; uz = pz / l;
  } else {
    const px = bx - ax * d, py = by - ay * d, pz = bz - az * d;
    const l = Math.hypot(px, py, pz) || 1;
    ux = px / l; uy = py / l; uz = pz / l;
  }

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = span ? span.t0 + t * (span.t1 - span.t0) : t;
    const r = (ra + (rb - ra) * t) * (1 + h * Math.sin(Math.PI * s));
    let x: number, y: number, z: number;
    if (i === 0 || theta < EPS) {
      x = ax; y = ay; z = az;
    } else if (i === n) {
      x = bx; y = by; z = bz;
    } else {
      const phi = t * theta;
      const c = Math.cos(phi), s = Math.sin(phi);
      x = ax * c + ux * s; y = ay * c + uy * s; z = az * c + uz * s;
    }
    out[i * 3] = x * r;
    out[i * 3 + 1] = y * r;
    out[i * 3 + 2] = z * r;
  }
};
