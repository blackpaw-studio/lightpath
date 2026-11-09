import { describe, expect, it } from "vitest";
import type { Destination, Hop, Origin, ServerMsg } from "./protocol";
import { initialState, interrupt, reduce, type TraceState } from "./reducer";

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
  it("trace.started bumps the trace generation, even for the same target", () => {
    const first = run(started, hop(1));
    const second = reduce(first, started);
    expect(initialState.generation).toBe(0);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(reduce(second, hop(1)).generation).toBe(2);
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

describe("interrupt", () => {
  it("ends a running trace as interrupted, keeping its hops and generation", () => {
    const running = deepFreeze(run(started, hop(1), hop(2)));
    const s = interrupt(running, "disconnected", "Connection to the agent lost: trace interrupted.");
    expect(s).toMatchObject({ status: "error", hops: running.hops, generation: running.generation, target: "example.com" });
    expect(s.error).toEqual({ code: "disconnected", message: "Connection to the agent lost: trace interrupted." });
  });
  it("records a user cancel with its own code", () => {
    expect(interrupt(run(started), "cancelled", "Trace cancelled.").error).toEqual({ code: "cancelled", message: "Trace cancelled." });
  });
  it("leaves idle, done and error states untouched", () => {
    const done = run(started, hop(1), { type: "trace.done", reached: true });
    expect(interrupt(initialState, "cancelled", "x")).toBe(initialState);
    expect(interrupt(done, "disconnected", "x")).toBe(done);
  });
});

describe("end reason and destination", () => {
  const dest: Destination = {
    ip: "9.9.9.9", reachable: true, port: 443, rttMs: 12, host: null, asn: null, org: null,
    lat: null, lon: null, city: null, geoSource: "estimated",
  };
  it("starts with neither", () => {
    expect(run(started)).toMatchObject({ endReason: null, destination: null });
  });
  it("derives the reason from reached for a legacy trace.done", () => {
    expect(run(started, { type: "trace.done", reached: true })).toMatchObject({ endReason: "reached", destination: null });
    expect(run(started, { type: "trace.done", reached: false })).toMatchObject({ endReason: "limit" });
  });
  it("records the reason and destination of a quiet finish", () => {
    const s = run(started, { type: "trace.done", reached: false, reason: "quiet", destination: dest });
    expect(s).toMatchObject({ status: "done", reached: false, endReason: "quiet", destination: dest });
  });
  it("records an agent error as the end reason", () => {
    expect(run(started, { type: "error", code: "traceroute_failed", message: "x" }).endReason).toBe("error");
  });
  it("records a user cancel as cancelled and a dropped connection as error", () => {
    expect(interrupt(run(started), "cancelled", "x").endReason).toBe("cancelled");
    expect(interrupt(run(started), "disconnected", "x").endReason).toBe("error");
  });
  it("trace.started clears both", () => {
    const done = run(started, { type: "trace.done", reached: false, reason: "quiet", destination: dest });
    expect(reduce(done, started)).toMatchObject({ endReason: null, destination: null });
  });
});

