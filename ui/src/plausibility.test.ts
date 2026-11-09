import { describe, expect, it } from "vitest";
import { latLonToVec3 } from "./geo";
import { checkLocations, isPlausible, KM_PER_MS_RTT, SLACK_KM, EARTH_KM } from "./plausibility";
import type { Destination, GeoSource, Hop, Origin } from "./protocol";
import { initialState, type TraceState } from "./reducer";

const BROOKLYN = { lat: 40.68, lon: -73.94 };
const origin: Origin = { publicIp: "192.0.2.10", ...BROOKLYN, city: "Brooklyn", asn: 701, org: null };

const hop = (ttl: number, rtt: number | null, geo: Partial<Hop> = {}): Hop => ({
  ttl, probes: [{ ip: "1.2.3.4", rttMs: rtt }, { ip: "1.2.3.4", rttMs: rtt === null ? null : rtt + 3 }],
  ip: "1.2.3.4", host: null, asn: null, org: null, lat: 40.71, lon: -74.0, city: "New York", geoSource: "api", annotations: [], ...geo,
});

const dest = (geo: Partial<Destination> = {}): Destination => ({
  ip: "9.9.9.9", reachable: true, port: 443, rttMs: 10, host: null, asn: null, org: null,
  lat: -27.47, lon: 153.03, city: "Brisbane", geoSource: "api", ...geo,
});

const stateOf = (hops: readonly Hop[], over: Partial<TraceState> = {}): TraceState =>
  ({ ...initialState, status: "done", origin, hops, ...over });

const BRISBANE: Partial<Hop> = { lat: -27.47, lon: 153.03, city: "Brisbane" };

describe("isPlausible", () => {
  const o = latLonToVec3(BROOKLYN.lat, BROOKLYN.lon);

  it("rejects Brisbane at 10 ms from New York", () => {
    expect(isPlausible(o, latLonToVec3(-27.47, 153.03), 10)).toBe(false);
  });

  it("accepts a nearby place at a low delay", () => {
    expect(isPlausible(o, latLonToVec3(40.71, -74.0), 1)).toBe(true);
  });

  it("is a closed bound at exactly 100 km per ms plus the slack, and fails 1 km past it", () => {
    const rtt = 20;
    const limitKm = KM_PER_MS_RTT * rtt + SLACK_KM;
    const at = (km: number) => latLonToVec3(BROOKLYN.lat + (km / EARTH_KM) * (180 / Math.PI), BROOKLYN.lon);
    expect(isPlausible(o, at(limitKm - 0.01), rtt)).toBe(true);
    expect(isPlausible(o, at(limitKm + 1), rtt)).toBe(false);
  });
});

describe("checkLocations", () => {
  it("turns the Brisbane hop at 10 ms from Brooklyn into a located-nowhere estimate with a doubt", () => {
    const shown = checkLocations(stateOf([hop(1, 1, { geoSource: "local", lat: 40.68, lon: -73.94 }), hop(2, 10, BRISBANE)]));
    const h = shown.hops[1]!;
    expect(h).toMatchObject({ lat: null, lon: null, city: null, geoSource: "estimated", ttl: 2 });
    expect(shown.doubts.get(2)).toEqual({ place: "Brisbane", rttMs: 10 });
  });

  it("uses the smallest probe delay", () => {
    const h = hop(2, 10, BRISBANE);
    const shown = checkLocations(stateOf([{ ...h, probes: [{ ip: "x", rttMs: 300 }, { ip: "x", rttMs: 10 }, { ip: "x", rttMs: null }] }]));
    expect(shown.doubts.get(2)?.rttMs).toBe(10);
  });

  it("keeps a plausible hop and a hop whose geo is hostname-measured and plausible", () => {
    const hops = [hop(1, 1), hop(2, 30, { geoSource: "hostname", lat: 41.88, lon: -87.63, city: "Chicago" })];
    const shown = checkLocations(stateOf(hops));
    expect(shown.hops).toEqual(hops);
    expect(shown.doubts.size).toBe(0);
  });

  it("checks hostname-sourced locations too", () => {
    const shown = checkLocations(stateOf([hop(2, 10, { ...BRISBANE, geoSource: "hostname" })]));
    expect(shown.doubts.has(2)).toBe(true);
  });

  it("leaves local and estimated hops alone", () => {
    const hops = [hop(1, 1, { ...BRISBANE, geoSource: "local" }), hop(2, 1, { ...BRISBANE, geoSource: "estimated" as GeoSource })];
    expect(checkLocations(stateOf(hops)).hops).toEqual(hops);
  });

  it("leaves a hop with no reply delay or no coordinates unchanged", () => {
    const hops = [hop(2, null, BRISBANE), hop(3, 5, { lat: null, lon: null, city: null })];
    const shown = checkLocations(stateOf(hops));
    expect(shown.hops).toEqual(hops);
    expect(shown.doubts.size).toBe(0);
  });

  it("passes the state through when there is no origin location", () => {
    const hops = [hop(2, 10, BRISBANE)];
    const noOrigin = stateOf(hops, { origin: { ...origin, lat: null, lon: null } });
    const shown = checkLocations(noOrigin);
    expect(shown.hops).toEqual(hops);
    expect(shown.doubts.size).toBe(0);
  });

  it("falls back to the first located hop as the origin", () => {
    const hops = [hop(1, 1, { geoSource: "local", lat: 40.68, lon: -73.94 }), hop(2, 10, BRISBANE)];
    const shown = checkLocations(stateOf(hops, { origin: null }));
    expect(shown.doubts.has(2)).toBe(true);
    expect(shown.doubts.has(1)).toBe(false);
  });

  it("doubts a reachable destination placed too far for its TCP delay", () => {
    const shown = checkLocations(stateOf([hop(1, 1)], { destination: dest() }));
    expect(shown.destination).toMatchObject({ lat: null, lon: null, city: null, geoSource: "estimated", ip: "9.9.9.9" });
    expect(shown.destinationDoubt).toEqual({ place: "Brisbane", rttMs: 10 });
  });

  it("never doubts an unreachable destination (no delay to test against)", () => {
    const d = dest({ reachable: false, port: null, rttMs: null });
    const shown = checkLocations(stateOf([hop(1, 1)], { destination: d }));
    expect(shown.destination).toEqual(d);
    expect(shown.destinationDoubt).toBeNull();
  });

  it("keeps a plausible destination", () => {
    const d = dest({ lat: 41.88, lon: -87.63, city: "Chicago", rttMs: 20 });
    const shown = checkLocations(stateOf([hop(1, 1)], { destination: d }));
    expect(shown.destination).toEqual(d);
    expect(shown.destinationDoubt).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = stateOf([hop(1, 1), hop(2, 10, BRISBANE)], { destination: dest() });
    const copy = structuredClone(input);
    checkLocations(input);
    expect(input).toEqual(copy);
  });

  it("returns the same hop objects it did not change", () => {
    const hops = [hop(1, 1), hop(2, 10, BRISBANE)];
    expect(checkLocations(stateOf(hops)).hops[0]).toBe(hops[0]);
  });
});
