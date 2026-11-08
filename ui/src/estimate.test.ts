import { describe, expect, it } from "vitest";
import { estimatePosition } from "./estimate";
import { angularDistance, latLonToVec3 } from "./geo";

const origin = latLonToVec3(0, 0);
const A = latLonToVec3(0, 40);
const B = latLonToVec3(0, 80);

describe("estimatePosition", () => {
  it("interpolates between neighbours at (ttl-prev)/(next-prev)", () => {
    const p = estimatePosition(3, [{ ttl: 2, pos: A }, { ttl: 5, pos: B }], origin);
    expect(angularDistance(A, p)).toBeCloseTo(angularDistance(A, B) / 3, 9);
    expect(angularDistance(p, B)).toBeCloseTo((2 * angularDistance(A, B)) / 3, 9);
  });
  it("uses nearest located neighbours regardless of order", () => {
    const far = latLonToVec3(50, 100);
    const p = estimatePosition(3, [{ ttl: 6, pos: far }, { ttl: 4, pos: B }, { ttl: 1, pos: far }, { ttl: 2, pos: A }], origin);
    expect(angularDistance(p, A)).toBeCloseTo(angularDistance(A, B) / 2, 9);
  });
  it("only a previous neighbour → that neighbour", () => {
    expect(estimatePosition(7, [{ ttl: 3, pos: A }], origin)).toEqual(A);
  });
  it("only a next neighbour → the origin", () => {
    expect(estimatePosition(1, [{ ttl: 4, pos: B }], origin)).toEqual(origin);
  });
  it("no located hops → the origin", () => {
    expect(estimatePosition(2, [], origin)).toEqual(origin);
  });
});
