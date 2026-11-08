import { describe, expect, it } from "vitest";
import { decodeLandDots, encodeLandDots, fibonacciLattice, inLand, type LandPolygon } from "./landgrid";

describe("fibonacciLattice", () => {
  it("returns n points spread from pole to pole within valid ranges", () => {
    const pts = fibonacciLattice(1000);
    expect(pts).toHaveLength(1000);
    expect(pts.every(([lat, lon]) => lat > -90 && lat < 90 && lon >= -180 && lon < 180)).toBe(true);
    const north = pts.filter(([lat]) => lat > 0).length;
    expect(Math.abs(north - 500)).toBeLessThanOrEqual(1);
  });

  it("covers equal areas with equal counts (band 0–30° holds half a hemisphere)", () => {
    const pts = fibonacciLattice(10000);
    const band = pts.filter(([lat]) => lat >= 0 && lat < 30).length;
    expect(band / 10000).toBeCloseTo(0.25, 2);
  });
});

describe("inLand", () => {
  const square: LandPolygon = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
  const withHole: LandPolygon = [square[0]!, [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];

  it("accepts points inside the outer ring and rejects outside", () => {
    expect(inLand(5, 5, [square])).toBe(true); // lat 5, lon 5
    expect(inLand(5, 15, [square])).toBe(false);
    expect(inLand(-1, 5, [square])).toBe(false);
  });

  it("treats holes as water", () => {
    expect(inLand(5, 5, [withHole])).toBe(false);
    expect(inLand(2, 2, [withHole])).toBe(true);
  });

  it("checks every polygon", () => {
    const far: LandPolygon = [[[100, 40], [110, 40], [110, 50], [100, 50], [100, 40]]];
    expect(inLand(45, 105, [square, far])).toBe(true);
  });
});

describe("encode/decodeLandDots", () => {
  it("round-trips lat/lon within quantisation error", () => {
    const pts: [number, number][] = [[0, 0], [89.9, 179.9], [-89.9, -180], [41.88, -87.63]];
    const out = decodeLandDots(encodeLandDots(pts));
    expect(out).toHaveLength(pts.length * 2);
    pts.forEach(([lat, lon], i) => {
      expect(out[i * 2]).toBeCloseTo(lat, 2);
      expect(out[i * 2 + 1]).toBeCloseTo(lon, 2);
    });
  });

  it("encodes 4 bytes per dot", () => {
    expect(encodeLandDots([[1, 2], [3, 4]]).byteLength).toBe(8);
  });

  it("rejects buffers that are not whole dots", () => {
    expect(() => decodeLandDots(new ArrayBuffer(6))).toThrow();
  });
});
