import { describe, expect, it } from "vitest";
import { angularDistance, arcPoints, latLonToVec3, slerpGreatCircle, type Vec3 } from "./geo";

const len = (v: Vec3) => Math.hypot(...v);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const close = (a: Vec3, b: Vec3, d = 1e-9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i] as number, 9 - Math.log10(1 / d) + 9 - 9));

describe("latLonToVec3", () => {
  it("maps poles and equator onto the unit sphere", () => {
    close(latLonToVec3(90, 0), [0, 1, 0]);
    close(latLonToVec3(-90, 123), [0, -1, 0]);
    close(latLonToVec3(0, 0), [1, 0, 0]);
    expect(len(latLonToVec3(41.9, -87.6))).toBeCloseTo(1, 12);
  });
});

describe("slerpGreatCircle", () => {
  const a = latLonToVec3(0, 0);
  const b = latLonToVec3(0, 90);
  it("returns exact endpoints", () => {
    expect(slerpGreatCircle(a, b, 0)).toEqual(a);
    expect(slerpGreatCircle(a, b, 1)).toEqual(b);
  });
  it("midpoint lies on the great circle halfway", () => {
    const m = slerpGreatCircle(a, b, 0.5);
    close(m, latLonToVec3(0, 45));
    expect(angularDistance(a, m)).toBeCloseTo(Math.PI / 4, 9);
  });
  it("handles identical points", () => {
    close(slerpGreatCircle(a, a, 0.5), a);
  });
  it("picks a deterministic perpendicular axis for antipodal points", () => {
    const p = latLonToVec3(10, 20);
    const q: Vec3 = [-p[0], -p[1], -p[2]];
    const m = slerpGreatCircle(p, q, 0.5);
    expect(len(m)).toBeCloseTo(1, 9);
    expect(dot(m, p)).toBeCloseTo(0, 9);
    expect(slerpGreatCircle(p, q, 0.5)).toEqual(m);
  });
});

describe("arcPoints", () => {
  const a = latLonToVec3(0, 0);
  it("returns n+1 points with endpoints at radius 1", () => {
    const pts = arcPoints(a, latLonToVec3(0, 60), 8);
    expect(pts).toHaveLength(9);
    close(pts[0]!, a);
    expect(len(pts[8]!)).toBeCloseTo(1, 9);
  });
  it("peaks at radius 1 + k·θ in the middle", () => {
    const b = latLonToVec3(0, 60);
    const pts = arcPoints(a, b, 2, 0.5);
    expect(len(pts[1]!)).toBeCloseTo(1 + 0.5 * angularDistance(a, b), 9);
  });
  it("arc height grows monotonically with distance", () => {
    const peaks = [10, 40, 90, 150].map((d) => len(arcPoints(a, latLonToVec3(0, d), 2)[1]!));
    expect([...peaks].sort((x, y) => x - y)).toEqual(peaks);
    expect(new Set(peaks).size).toBe(4);
  });
});

describe("arcPoints segment clamp", () => {
  it("yields finite points for n=0", () => {
    const pts = arcPoints(latLonToVec3(0, 0), latLonToVec3(0, 60), 0);
    expect(pts.length).toBe(2);
    expect(pts.every((p) => p.every(Number.isFinite))).toBe(true);
  });
});
