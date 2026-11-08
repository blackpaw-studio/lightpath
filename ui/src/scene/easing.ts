export const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/** Hermite smoothstep; exactly 0 at/below e0 and exactly 1 at/above e1. */
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export const easeInOutCubic = (p: number): number => {
  const t = clamp01(p);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** Cubic Hermite on [0,1]: values a,b with derivatives ma,mb (per unit u). */
export const hermite = (a: number, b: number, ma: number, mb: number, u: number): number => {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * ma + (-2 * u3 + 3 * u2) * b + (u3 - u2) * mb;
};
