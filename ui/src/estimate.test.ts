import { describe, expect, it } from "vitest";
import { estimatePosition, estimatePositions } from "./estimate";
import { angularDistance, latLonToVec3, type Vec3 } from "./geo";
import type { LocatedHop } from "./estimate";

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

describe("estimatePositions by reply delay", () => {
  const NY = latLonToVec3(40.7, -74);
  const LONDON = latLonToVec3(51.5, -0.1);
  const anchors: LocatedHop[] = [{ ttl: 2, pos: NY, rttMs: 9 }, { ttl: 6, pos: LONDON, rttMs: 72 }];
  const fraction = (p: Vec3): number => angularDistance(NY, p) / angularDistance(NY, LONDON);
  const place = (hops: { ttl: number; rttMs: number | null }[], a: readonly LocatedHop[] = anchors) => estimatePositions(hops, a, origin);

  it("puts a 10 ms hop between New York (9 ms) and London (72 ms) next to New York, not mid-Atlantic", () => {
    expect(fraction(place([{ ttl: 4, rttMs: 10 }]).get(4)!)).toBeCloseTo(1 / 63, 9);
  });

  it("falls back to the ttl fraction for a hop with no delay, or when an anchor has none", () => {
    expect(fraction(place([{ ttl: 3, rttMs: null }]).get(3)!)).toBeCloseTo(0.25, 9);
    const noRtt = [{ ttl: 2, pos: NY, rttMs: null }, { ttl: 6, pos: LONDON, rttMs: 72 }];
    expect(fraction(place([{ ttl: 3, rttMs: 10 }], noRtt).get(3)!)).toBeCloseTo(0.25, 9);
    expect(fraction(place([{ ttl: 3, rttMs: 10 }], [{ ttl: 2, pos: NY }, { ttl: 6, pos: LONDON }]).get(3)!)).toBeCloseTo(0.25, 9);
  });

  it("falls back to the ttl fraction when the far anchor is not slower than the near one", () => {
    const flat = [{ ttl: 2, pos: NY, rttMs: 50 }, { ttl: 6, pos: LONDON, rttMs: 50 }];
    expect(fraction(place([{ ttl: 3, rttMs: 50 }], flat).get(3)!)).toBeCloseTo(0.25, 9);
  });

  it("places a hop whose delay is outside the anchors' range by ttl, not on the nearer anchor", () => {
    const p = place([{ ttl: 3, rttMs: 200 }, { ttl: 4, rttMs: 250 }, { ttl: 5, rttMs: 2 }]);
    expect([3, 4, 5].map((t) => fraction(p.get(t)!))).toEqual([0.25, 0.5, 0.75].map((f) => expect.closeTo(f, 9)));
  });

  describe("slow routers (delays outside the anchors' range)", () => {
    const close = [{ ttl: 2, pos: NY, rttMs: 20 }, { ttl: 6, pos: LONDON, rttMs: 30 }];
    const fractions = (hops: { ttl: number; rttMs: number | null }[], a = close): number[] => {
      const p = place(hops, a);
      return hops.map((h) => fraction(p.get(h.ttl)!));
    };

    it("spreads hops at 18 and 19 ms between anchors at 20 and 30 ms, distinct and in order", () => {
      const f = fractions([{ ttl: 3, rttMs: 18 }, { ttl: 4, rttMs: 19 }, { ttl: 5, rttMs: 19.5 }]);
      expect(f).toEqual([0.25, 0.5, 0.75].map((x) => expect.closeTo(x, 9)));
    });

    it("keeps in-range hops with near-identical delays a minimum gap apart (a quarter of the ttl step)", () => {
      const f = fractions([{ ttl: 3, rttMs: 20.1 }, { ttl: 4, rttMs: 20.1 }, { ttl: 5, rttMs: 20.2 }]);
      const gap = 0.25 / 4;
      expect(f[1]! - f[0]!).toBeGreaterThanOrEqual(gap - 1e-9);
      expect(f[2]! - f[1]!).toBeGreaterThanOrEqual(gap - 1e-9);
      expect(f[0]).toBeCloseTo(0.01, 9); // still next to the near anchor, as its delay says
    });

    it("rescales a run crowded against the far anchor to stay inside [0,1], in order and finite", () => {
      const f = fractions([{ ttl: 3, rttMs: 29.9 }, { ttl: 4, rttMs: 29.95 }, { ttl: 5, rttMs: 29.99 }]);
      expect(f.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
      expect(f[1]!).toBeGreaterThan(f[0]!);
      expect(f[2]!).toBeGreaterThan(f[1]!);
      expect(f[2]!).toBeLessThan(1);
    });

    it("never produces NaN, even for a lone hop at the far anchor's delay or equal anchor delays", () => {
      const flat = [{ ttl: 2, pos: NY, rttMs: 20 }, { ttl: 6, pos: LONDON, rttMs: 20 }];
      for (const [hops, a] of [[[{ ttl: 3, rttMs: 30 }], close], [[{ ttl: 3, rttMs: 20 }, { ttl: 4, rttMs: 20 }], flat], [[{ ttl: 3, rttMs: 29.999 }], close]] as const) {
        const p = place([...hops], a);
        for (const h of hops) expect(p.get(h.ttl)!.every(Number.isFinite)).toBe(true);
      }
    });
  });

  it("keeps a run monotonic: a faster hop later in the path never lands behind its predecessor", () => {
    const p = place([{ ttl: 3, rttMs: 60 }, { ttl: 4, rttMs: 20 }, { ttl: 5, rttMs: 70 }]);
    const f = [3, 4, 5].map((t) => fraction(p.get(t)!));
    expect(f[1]).toBeGreaterThanOrEqual(f[0]! - 1e-9);
    expect(f[2]).toBeGreaterThanOrEqual(f[1]! - 1e-9);
  });

  it("places a silent hop by ttl between its delay-placed neighbours", () => {
    const p = place([{ ttl: 3, rttMs: 20 }, { ttl: 4, rttMs: null }, { ttl: 5, rttMs: 70 }]);
    const [a, b, c] = [3, 4, 5].map((t) => fraction(p.get(t)!)) as [number, number, number];
    expect(b).toBeCloseTo((a + c) / 2, 9);
  });

  it("still puts hops with only a previous neighbour on it, and with none on the origin", () => {
    expect(place([{ ttl: 9, rttMs: 5 }], [{ ttl: 2, pos: NY, rttMs: 9 }]).get(9)).toEqual(NY);
    expect(place([{ ttl: 1, rttMs: 5 }], [{ ttl: 2, pos: NY, rttMs: 9 }]).get(1)).toEqual(origin);
  });
});
