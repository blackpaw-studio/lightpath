import { describe, expect, it } from "vitest";
import { latLonToVec3, type Vec3 } from "../geo";
import type { Destination, Hop } from "../protocol";
import { initialState, type TraceState } from "../reducer";
import {
  gateLabel, gateSpacing, helixLocal, isTimeoutHop, MAX_RTT_DEPTH, MIN_GAP, RTT_GAP_K, tunnelFrame, tunnelGates, tunnelPoint,
} from "./tunnelLayout";

const hop = (ttl: number, rtts: (number | null)[], extra: Partial<Hop> = {}): Hop => ({
  ttl, ip: `10.0.0.${ttl}`, host: null, asn: null, org: null, lat: null, lon: null, city: null,
  geoSource: "estimated", annotations: [], probes: rtts.map((r) => ({ ip: r === null ? null : `10.0.0.${ttl}`, rttMs: r })),
  ...extra,
});
const state = (hops: Hop[]): TraceState => ({ ...initialState, status: "running", hops });
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(...a);

describe("gateSpacing", () => {
  const gaps = (s: number[]): number[] => s.map((x, i) => x - (s[i - 1] ?? 0));

  it("adds every RTT increase on top of the minimum gap, however small", () => {
    const g = gaps(gateSpacing([10, 12]));
    expect(g[0]).toBeCloseTo(MIN_GAP + RTT_GAP_K * 10, 12);
    expect(g[1]).toBeCloseTo(MIN_GAP + RTT_GAP_K * 2, 12);
  });
  it("spaces in proportion to the RTT delta", () => {
    const g = gaps(gateSpacing([10, 110, 160]));
    expect(g[1]! - MIN_GAP).toBeCloseTo(2 * (g[2]! - MIN_GAP), 12);
  });
  it("clamps negative deltas to the minimum gap and measures from the new value", () => {
    const g = gaps(gateSpacing([200, 20, 25]));
    expect(g[1]).toBeCloseTo(MIN_GAP, 12);
    expect(g[2]).toBeCloseTo(MIN_GAP + RTT_GAP_K * 5, 12);
  });
  it("timeouts get the minimum gap and do not reset the RTT baseline", () => {
    const g = gaps(gateSpacing([50, null, 150]));
    expect(g[1]).toBeCloseTo(MIN_GAP, 12);
    expect(g[2]).toBeCloseTo(MIN_GAP + RTT_GAP_K * 100, 12);
  });
  it("is strictly increasing", () => {
    const s = gateSpacing([5, null, 3, 300, 1, null, null, 2]);
    s.slice(1).forEach((x, i) => expect(x).toBeGreaterThan(s[i]!));
  });
  it("caps the depth RTT adds, keeping the proportions (a satellite hop never makes the tube absurd)", () => {
    const rtts = Array.from({ length: 20 }, (_, i) => 40 * (i + 1));
    const s = gateSpacing(rtts);
    expect(s[s.length - 1]).toBeCloseTo(20 * MIN_GAP + MAX_RTT_DEPTH, 9);
    const g = gaps(s);
    g.forEach((x) => expect(x).toBeCloseTo(g[0]!, 9));
  });
  it("keeps a typical 10–150 ms route between 1x and 2x the minimum-gap length", () => {
    const s = gateSpacing([1, 8, 11, 14, null, 78, 84, 91, 129, 140, 146, 150]);
    expect(s[s.length - 1]! / (12 * MIN_GAP)).toBeGreaterThan(1.3);
    expect(s[s.length - 1]! / (12 * MIN_GAP)).toBeLessThan(2);
  });
});

describe("timeout gates", () => {
  it("selects hops whose every probe timed out", () => {
    expect(isTimeoutHop(hop(1, [null, null, null]))).toBe(true);
    expect(isTimeoutHop(hop(1, [null, 12, null]))).toBe(false);
    expect(isTimeoutHop(hop(1, [3, 4, 5]))).toBe(false);
    expect(isTimeoutHop(hop(1, []))).toBe(true);
  });
  it("tunnelGates marks exactly the timeout-only hops as broken", () => {
    const gates = tunnelGates(state([hop(1, [1, 1, 1]), hop(2, [null, null, null]), hop(3, [null, 9, null])]));
    expect(gates.map((g) => [g.ttl, g.broken])).toEqual([[1, false], [2, true], [3, false]]);
  });
  it("gates follow ttl order and gateSpacing", () => {
    const gates = tunnelGates(state([hop(1, [1]), hop(2, [130]), hop(3, [null])]));
    expect(gates.map((g) => g.s)).toEqual(gateSpacing([1, 130, null]));
  });
  it("no hops, no gates", () => {
    expect(tunnelGates(initialState)).toEqual([]);
  });
});

describe("gateLabel", () => {
  it("shows hostname · ASN/org · RTT", () => {
    const l = gateLabel(hop(4, [10, 12, 14], { host: "ae-1.r01.nyc.example.net", asn: 3356, org: "Lumen" }));
    expect(l).toEqual({ ttl: 4, title: "ae-1.r01.nyc.example.net", detail: "AS3356 Lumen · 12.0 ms" });
  });
  it("falls back to the IP, then to asterisks for a timeout", () => {
    expect(gateLabel(hop(2, [5])).title).toBe("10.0.0.2");
    expect(gateLabel({ ...hop(3, [null, null]), ip: null })).toEqual({ ttl: 3, title: "* * *", detail: "no reply" });
  });
});

describe("helix and tunnel frame", () => {
  it("helix starts on the axis, heading straight down it", () => {
    expect(helixLocal(0)).toEqual([0, 0, 0]);
    const a = helixLocal(1e-4);
    expect(Math.hypot(a[0], a[1]) / a[2]).toBeLessThan(1e-3);
  });
  it("frame is orthonormal with +z along the inward surface normal", () => {
    const origin = latLonToVec3(40.7, -74);
    const f = tunnelFrame(origin, [0, 1, 0]);
    expect(dot(f.n, origin)).toBeCloseTo(-1, 12);
    [f.u, f.v, f.n].forEach((a) => expect(len(a)).toBeCloseTo(1, 12));
    expect(dot(f.u, f.v)).toBeCloseTo(0, 12);
    expect(dot(f.v, f.n)).toBeCloseTo(0, 12);
    expect(dot(f.u, f.n)).toBeCloseTo(0, 12);
    const uxv: Vec3 = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]];
    expect(dot(uxv, f.n)).toBeCloseTo(1, 12); // right-handed, so the tube's matrix never mirrors its winding
  });
  it("keeps v as close to the up hint as possible", () => {
    const f = tunnelFrame([1, 0, 0], [0.3, 1, 0]);
    expect(f.v[1]).toBeCloseTo(1, 12);
  });
  it("survives an up hint parallel to the normal", () => {
    const f = tunnelFrame([0, 1, 0], [0, -1, 0]);
    expect(len(f.v)).toBeCloseTo(1, 12);
    expect(dot(f.v, f.n)).toBeCloseTo(0, 12);
  });
  it("tunnel s = 0 is the origin node; deeper s goes into the globe", () => {
    const origin = latLonToVec3(10, 20);
    const f = tunnelFrame(origin, [0, 1, 0]);
    tunnelPoint(f, 0).forEach((x, i) => expect(x).toBeCloseTo(origin[i]!, 12));
    expect(len(tunnelPoint(f, 0.5))).toBeLessThan(1);
  });
});

describe("tunnelGates destination", () => {
  const dest: Destination = {
    ip: "9.9.9.9", reachable: true, port: 443, rttMs: 18.4, host: null, asn: 13335, org: "CLOUDFLARENET",
    lat: 35, lon: 139, city: "Tokyo", geoSource: "api",
  };
  const finished = (over: Partial<TraceState> = {}): TraceState => ({
    ...state([hop(1, [5]), hop(2, [null, null, null])]), status: "done", endReason: "quiet", destination: dest, ...over,
  });
  it("ends with an estimated Destination gate named by network and delay", () => {
    const gates = tunnelGates(finished());
    expect(gates.at(-1)).toMatchObject({ ttl: 3, title: "Destination", detail: "Cloudflare · 18 ms", estimated: true, broken: false });
    expect(gates.at(-1)!.s).toBeGreaterThan(gates.at(-2)!.s);
  });
  it("marks real hops as not estimated", () => {
    expect(tunnelGates(finished()).slice(0, 2).map((g) => g.estimated)).toEqual([false, false]);
  });
  it("has no destination gate when unreachable, unlocated, or the trace did not stop quiet", () => {
    expect(tunnelGates(finished({ destination: { ...dest, reachable: false, port: null, rttMs: null } }))).toHaveLength(2);
    expect(tunnelGates(finished({ destination: { ...dest, lat: null, lon: null } }))).toHaveLength(2);
    expect(tunnelGates(finished({ endReason: "reached" }))).toHaveLength(2);
  });
});

