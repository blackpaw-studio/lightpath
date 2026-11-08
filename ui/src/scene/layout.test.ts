import { describe, expect, it } from "vitest";
import { latLonToVec3, slerpGreatCircle } from "../geo";
import { NO_RTT_COLOR, rttColor } from "../color";
import type { Hop, Origin } from "../protocol";
import { initialState, type TraceState } from "../reducer";
import { globeLayout } from "./layout";

const origin: Origin = { publicIp: "1.2.3.4", lat: 40, lon: -74, city: "NYC", asn: 1, org: "x" };
const hop = (ttl: number, p: Partial<Hop> = {}): Hop => ({
  ttl, probes: [{ ip: "9.9.9.9", rttMs: 10 }], ip: "9.9.9.9", host: null, asn: null, org: null,
  lat: null, lon: null, city: null, geoSource: "estimated", annotations: [], ...p,
});
const state = (hops: Hop[], o: Origin | null = origin): TraceState => ({ ...initialState, status: "running", origin: o, hops });

describe("globeLayout", () => {
  it("places the origin and located hops at their lat/lon", () => {
    const l = globeLayout(state([hop(1, { lat: 51.5, lon: 0, geoSource: "api" })]));
    expect(l.origin).toEqual(latLonToVec3(40, -74));
    expect(l.hops[0]!.pos).toEqual(latLonToVec3(51.5, 0));
    expect(l.hops[0]!.estimated).toBe(false);
  });

  it("estimates hops without geo between their located neighbours", () => {
    const a = latLonToVec3(10, 10);
    const b = latLonToVec3(20, 40);
    const l = globeLayout(state([
      hop(1, { lat: 10, lon: 10, geoSource: "api" }), hop(2), hop(3), hop(4, { lat: 20, lon: 40, geoSource: "api" }),
    ]));
    expect(l.hops[1]!.estimated).toBe(true);
    l.hops[1]!.pos.forEach((x, i) => expect(x).toBeCloseTo(slerpGreatCircle(a, b, 1 / 3)[i]!, 12));
  });

  it("estimates leading hops at the origin", () => {
    const l = globeLayout(state([hop(1), hop(2, { lat: 20, lon: 40, geoSource: "api" })]));
    expect(l.hops[0]!.pos).toEqual(l.origin);
  });

  it("falls back to the first located hop, then (0,0), when the origin has no geo", () => {
    const noGeo = { ...origin, lat: null, lon: null };
    expect(globeLayout(state([hop(1, { lat: 5, lon: 6, geoSource: "api" })], noGeo)).origin).toEqual(latLonToVec3(5, 6));
    expect(globeLayout(state([hop(1)], null)).origin).toEqual(latLonToVec3(0, 0));
  });

  it("colours by mean RTT and flags timeout-only hops", () => {
    const l = globeLayout(state([
      hop(1, { probes: [{ ip: "a", rttMs: 70 }, { ip: "a", rttMs: 90 }, { ip: null, rttMs: null }] }),
      hop(2, { ip: null, probes: [{ ip: null, rttMs: null }, { ip: null, rttMs: null }] }),
    ]));
    expect(l.hops[0]).toMatchObject({ rttMs: 80, color: rttColor(80), timeout: false });
    expect(l.hops[1]).toMatchObject({ rttMs: null, color: NO_RTT_COLOR, timeout: true });
  });
});
