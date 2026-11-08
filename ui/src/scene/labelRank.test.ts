import { describe, expect, it } from "vitest";
import { labelVisibility } from "./labelRank";

describe("labelVisibility (declutter deep in the tunnel)", () => {
  it("shows the nearest two gates ahead fully, fades the third, hides the rest", () => {
    const [a, b, c, d, e] = labelVisibility([0.5, 1.1, 1.7, 2.3, 2.9]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBeGreaterThan(0.2);
    expect(c).toBeLessThan(0.8);
    expect(d).toBe(0);
    expect(e).toBe(0);
  });

  it("ignores input order", () => {
    expect(labelVisibility([2.3, 0.5, 1.7, 1.1])).toEqual([0, 1, labelVisibility([0.5, 1.1, 1.7])[2], 1]);
  });

  it("gates behind the camera never crowd out the ones ahead", () => {
    const [behind, near, next, third] = labelVisibility([-0.4, 0.5, 1.1, 1.7]);
    expect(behind).toBe(0);
    expect(near).toBe(1);
    expect(next).toBe(1);
    expect(third).toBeGreaterThan(0.2);
  });

  it("is continuous as the camera flies down the tunnel: no label fades faster than over 0.25 units of travel", () => {
    const gates = [0.6, 1.2, 1.8, 2.4, 3.0, 4.6];
    const dx = 4 / 1200;
    const series = Array.from({ length: 1201 }, (_, i) => labelVisibility(gates.map((s) => s - i * dx)));
    const steps = series.slice(1).flatMap((v, i) => v.map((x, k) => Math.abs(x - series[i]![k]!)));
    expect(Math.max(...steps) / dx).toBeLessThan(4);
  });
});
