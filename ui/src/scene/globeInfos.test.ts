import { describe, expect, it } from "vitest";
import type { Destination, Hop, Origin } from "../protocol";
import { initialState, type TraceState } from "../reducer";
import { arcInfos, nodeInfos } from "./globe";
import { globeLayout } from "./layout";

const origin: Origin = { publicIp: "1.2.3.4", lat: 40, lon: -74, city: "NYC", asn: 1, org: "x" };
const dest: Destination = {
  ip: "9.9.9.9", reachable: true, port: 443, rttMs: 20, host: null, asn: null, org: null, lat: 35, lon: 139, city: "Tokyo", geoSource: "api",
};
const hop = (ttl: number, silent: boolean): Hop => ({
  ttl, probes: [{ ip: silent ? null : "8.8.8.8", rttMs: silent ? null : 5 }], ip: silent ? null : "8.8.8.8", host: null, asn: null, org: null,
  lat: silent ? null : 51, lon: silent ? null : 0, city: null, geoSource: silent ? "estimated" : "api", annotations: [],
});
const quietDone = (destination: Destination | null): TraceState => ({
  ...initialState, status: "done", origin, hops: [hop(1, false), hop(2, true), hop(3, true)], reached: false, endReason: "quiet", destination,
});

describe("destination on the globe", () => {
  it("draws a dashed (estimated) arc into the destination and marks it as the destination node", () => {
    const s = quietDone(dest);
    const l = globeLayout(s);
    expect(arcInfos(l).at(-1)).toMatchObject({ from: 3, to: 4, estimated: true });
    expect(nodeInfos(s, l).get(4)).toMatchObject({ role: "destination", estimated: true });
  });
  it("draws an estimated arc and destination node for a located destination that does not answer", () => {
    const s = quietDone({ ...dest, reachable: false, port: null, rttMs: null });
    const l = globeLayout(s);
    expect(arcInfos(l).at(-1)).toMatchObject({ from: 3, to: 4, estimated: true });
    expect(nodeInfos(s, l).get(4)).toMatchObject({ role: "destination", estimated: true });
  });
  it("draws no arc or destination node when the destination does not answer and has no location", () => {
    const s = quietDone({ ...dest, reachable: false, port: null, rttMs: null, lat: null, lon: null });
    const l = globeLayout(s);
    expect(arcInfos(l)).toHaveLength(3);
    expect(nodeInfos(s, l).has(4)).toBe(false);
  });
});

describe("arc spans over runs of estimated hops", () => {
  const located = (ttl: number): Hop => ({ ...hop(ttl, false), lat: 10 * ttl, lon: 5 * ttl });
  const stateOf = (hops: Hop[], destination: Destination | null = null, over: Partial<TraceState> = {}): TraceState =>
    ({ ...initialState, status: "done", origin, hops, reached: true, endReason: "reached", destination, ...over });
  const spans = (s: TraceState) => arcInfos(globeLayout(s)).map((a) => a.span ?? null);

  it("gives every arc through a run between two located hops that run's span, (its anchors)", () => {
    const sp = spans(stateOf([located(1), hop(2, true), hop(3, true), located(4)]));
    expect(sp[0]).toBeNull();
    expect(sp[1]).toEqual({ from: 1, to: 4 });
    expect(sp[2]).toEqual({ from: 1, to: 4 });
    expect(sp[3]).toEqual({ from: 1, to: 4 });
  });

  it("uses the located destination as the run's far anchor", () => {
    const s = stateOf([located(1), hop(2, true), hop(3, true)], dest, { reached: false, endReason: "quiet" });
    const sp = spans(s);
    expect(sp[3]).toEqual({ from: 1, to: 4 });
  });

  it("leaves a run with no anchor on either side as plain arcs", () => {
    expect(spans(stateOf([hop(1, true), hop(2, true), located(3)])).every((x) => x === null)).toBe(true);
    expect(spans(stateOf([located(1), hop(2, true), hop(3, true)], null, { status: "running", endReason: null, reached: null })).every((x) => x === null)).toBe(true);
  });
});
