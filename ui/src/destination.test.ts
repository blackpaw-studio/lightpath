import { describe, expect, it } from "vitest";
import type { Destination, Hop } from "./protocol";
import { initialState, type TraceState } from "./reducer";
import { destinationTtl, sceneDestination } from "./destination";

const dest = (over: Partial<Destination> = {}): Destination => ({
  ip: "9.9.9.9", reachable: true, port: 443, rttMs: 12, host: null, asn: null, org: null,
  lat: 40, lon: -74, city: "New York", geoSource: "api", ...over,
});
const hop = (ttl: number): Hop => ({
  ttl, probes: [], ip: null, host: null, asn: null, org: null, lat: null, lon: null, city: null,
  geoSource: "estimated", annotations: [],
});
const quiet = (over: Partial<TraceState> = {}): TraceState => ({
  ...initialState, status: "done", reached: false, endReason: "quiet", destination: dest(), hops: [hop(1), hop(2)], ...over,
});

describe("sceneDestination", () => {
  it("is the destination of a quiet finish that answers and has a location", () => {
    expect(sceneDestination(quiet())).toEqual(dest());
  });
  it.each<[string, Partial<TraceState>]>([
    ["unreachable", { destination: dest({ reachable: false, port: null, rttMs: null }) }],
    ["no location", { destination: dest({ lat: null, lon: null }) }],
    ["no destination", { destination: null }],
    ["a reached trace", { endReason: "reached", reached: true }],
    ["a limit finish", { endReason: "limit" }],
    ["a running trace", { status: "running", endReason: null }],
  ])("is null for %s", (_n, over) => {
    expect(sceneDestination(quiet(over))).toBeNull();
  });
});

describe("destinationTtl", () => {
  it("sits one past the last hop", () => {
    expect(destinationTtl([hop(1), hop(7)])).toBe(8);
    expect(destinationTtl([])).toBe(1);
  });
});
