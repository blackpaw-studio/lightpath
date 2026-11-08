import { describe, expect, it } from "vitest";
import type { Hop, Origin, ServerMsg } from "./protocol";
import { initialState, reduce, type TraceState } from "./reducer";

const origin: Origin = { publicIp: "1.1.1.1", lat: 1, lon: 2, city: "X", asn: null, org: null };
const hop = (ttl: number, over: Partial<Hop> = {}): Extract<ServerMsg, { type: "hop" }> => ({
  type: "hop", ttl, probes: [], ip: `10.0.0.${ttl}`, host: null, asn: null, org: null,
  lat: null, lon: null, city: null, geoSource: "estimated", annotations: [], ...over,
});
const started: ServerMsg = { type: "trace.started", target: "example.com", resolvedIp: "9.9.9.9", origin };
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};
const run = (...msgs: ServerMsg[]) => msgs.reduce(reduce, initialState);

describe("reduce", () => {
  it("trace.started resets state and records target/origin", () => {
    const s = reduce(run(started, hop(1), { type: "trace.done", reached: true }), { ...started, target: "b.com" });
    expect(s).toMatchObject({ status: "running", target: "b.com", origin, hops: [], reached: null, error: null });
  });
  it("inserts hops sorted by ttl, replacing duplicates", () => {
    const s = run(started, hop(3), hop(1), hop(2), hop(2, { ip: "new" }));
    expect(s.hops.map((h) => h.ttl)).toEqual([1, 2, 3]);
    expect(s.hops[1]!.ip).toBe("new");
  });
  it("hop.update shallow-merges only provided fields", () => {
    const s = run(started, hop(2, { host: "h" }), { type: "hop.update", ttl: 2, asn: 64500, lat: 5, lon: 6, geoSource: "api" });
    expect(s.hops[0]).toMatchObject({ host: "h", asn: 64500, lat: 5, lon: 6, geoSource: "api", ip: "10.0.0.2" });
  });
  it("hop.update can set a field to null explicitly", () => {
    const s = run(started, hop(2, { host: "h" }), { type: "hop.update", ttl: 2, host: null });
    expect(s.hops[0]!.host).toBeNull();
  });
  it("hop.update for unknown ttl is ignored (update before hop)", () => {
    const early = run(started, { type: "hop.update", ttl: 4, asn: 1 });
    expect(early.hops).toEqual([]);
    expect(reduce(early, hop(4)).hops[0]!.asn).toBeNull();
  });
  it("trace.done sets status and reached", () => {
    expect(run(started, { type: "trace.done", reached: true })).toMatchObject({ status: "done", reached: true });
  });
  it("error sets status and keeps hops", () => {
    const s = run(started, hop(1), { type: "error", code: "traceroute_failed", message: "boom" });
    expect(s).toMatchObject({ status: "error", error: { code: "traceroute_failed", message: "boom" } });
    expect(s.hops).toHaveLength(1);
  });
  it("never mutates its inputs and returns new objects", () => {
    const base: TraceState = deepFreeze(run(started, hop(1), hop(3)));
    const msgs: ServerMsg[] = [hop(2), { type: "hop.update", ttl: 1, asn: 5 }, { type: "trace.done", reached: false }, started];
    for (const m of msgs) {
      const next = reduce(base, m);
      expect(next).not.toBe(base);
    }
    expect(base.hops[0]!.asn).toBeNull();
    const upd = reduce(base, { type: "hop.update", ttl: 1, asn: 5 });
    expect(upd.hops[1]).toBe(base.hops[1]);
  });
});
