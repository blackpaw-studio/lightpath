import { describe, expect, it } from "vitest";
import { angularDistance, latLonToVec3, slerpGreatCircle } from "../geo";
import { NO_RTT_COLOR, rttColor } from "../color";
import type { Destination, Hop, Origin } from "../protocol";
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

  it("places a fast hop between two located neighbours next to the near one, by reply delay", () => {
    const ny = latLonToVec3(40.7, -74);
    const london = latLonToVec3(51.5, -0.1);
    const rtt = (ms: number) => ({ probes: [{ ip: "9.9.9.9", rttMs: ms }] });
    const l = globeLayout(state([
      hop(1, { lat: 40.7, lon: -74, geoSource: "api", ...rtt(9) }), hop(2, rtt(10)), hop(3, { lat: 51.5, lon: -0.1, geoSource: "api", ...rtt(72) }),
    ]));
    const f = angularDistance(ny, l.hops[1]!.pos) / angularDistance(ny, london);
    expect(f).toBeCloseTo(1 / 63, 6);
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

  it("falls back to the first located hop when the origin has no geo", () => {
    const noGeo = { ...origin, lat: null, lon: null };
    expect(globeLayout(state([hop(1, { lat: 5, lon: 6, geoSource: "api" })], noGeo)).origin).toEqual(latLonToVec3(5, 6));
  });

  it("has no origin (nothing to draw) before any trace", () => {
    expect(globeLayout(initialState)).toEqual({ generation: 0, origin: null, hops: [] });
    expect(globeLayout(state([], { ...origin, lat: null, lon: null })).origin).toBeNull();
  });

  it("carries the trace generation", () => {
    expect(globeLayout({ ...state([]), generation: 7 }).generation).toBe(7);
  });

  it("never fabricates (0,0): without any anchor, unlocated hops are left out", () => {
    const l = globeLayout(state([hop(1), hop(2)], { ...origin, lat: null, lon: null }));
    expect(l).toEqual({ generation: 0, origin: null, hops: [] });
  });

  it("falls back to a previously known origin until a real anchor exists", () => {
    const prev = latLonToVec3(40, -74);
    const l = globeLayout(state([hop(1)], { ...origin, lat: null, lon: null }), prev);
    expect(l.origin).toEqual(prev);
    expect(l.hops[0]!.pos).toEqual(prev);
    const anchored = globeLayout(state([hop(1, { lat: 5, lon: 6, geoSource: "api" })], { ...origin, lat: null, lon: null }), prev);
    expect(anchored.origin).toEqual(latLonToVec3(5, 6));
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

describe("globeLayout destination", () => {
  const dest: Destination = {
    ip: "9.9.9.9", reachable: true, port: 443, rttMs: 20, host: null, asn: null, org: null,
    lat: 35, lon: 139, city: "Tokyo", geoSource: "api",
  };
  const quietHop = (ttl: number): Hop => hop(ttl, { ip: null, probes: [{ ip: null, rttMs: null }] });
  const finished = (over: Partial<TraceState> = {}): TraceState => ({
    ...state([hop(1, { lat: 51.5, lon: 0, geoSource: "api" }), quietHop(2), quietHop(3), quietHop(4)]),
    status: "done", reached: false, endReason: "quiet", destination: dest, ...over,
  });

  it("appends an estimated destination one ttl past the last hop", () => {
    const l = globeLayout(finished());
    const last = l.hops.at(-1)!;
    expect(last).toMatchObject({ ttl: 5, estimated: true, timeout: false, rttMs: 20, color: rttColor(20) });
    expect(last.pos).toEqual(latLonToVec3(35, 139));
  });
  it("re-estimates the trailing quiet hops on the great circle from the last reply to the destination", () => {
    const a = latLonToVec3(51.5, 0);
    const b = latLonToVec3(35, 139);
    const l = globeLayout(finished());
    [2, 3, 4].forEach((ttl, i) => {
      const want = slerpGreatCircle(a, b, (i + 1) / 4);
      l.hops.find((h) => h.ttl === ttl)!.pos.forEach((x, k) => expect(x).toBeCloseTo(want[k]!, 12));
    });
  });
  it("adds nothing when the destination does not answer, has no location, or the trace did not stop quiet", () => {
    const base = globeLayout(finished({ destination: null }));
    expect(base.hops).toHaveLength(4);
    expect(globeLayout(finished({ destination: { ...dest, reachable: false, port: null, rttMs: null, lat: null, lon: null } })).hops).toHaveLength(4);
    expect(globeLayout(finished({ destination: { ...dest, lat: null, lon: null } })).hops).toHaveLength(4);
    expect(globeLayout(finished({ endReason: "limit" })).hops).toHaveLength(4);
  });
  it("joins a located destination that does not answer to the anchors, estimated and without a delay", () => {
    const l = globeLayout(finished({ destination: { ...dest, reachable: false, port: null, rttMs: null } }));
    expect(l.hops).toHaveLength(5);
    expect(l.hops.at(-1)).toMatchObject({ ttl: 5, estimated: true, rttMs: null });
    expect(l.hops.at(-1)!.pos).toEqual(latLonToVec3(35, 139));
  });
  it("never lets the destination stand in for a missing origin", () => {
    const noGeo = { ...origin, lat: null, lon: null };
    const l = globeLayout({ ...finished(), origin: noGeo, hops: [quietHop(1)] });
    expect(l.origin).toBeNull();
  });
});

