import { describe, expect, it } from "vitest";
import type { Destination, Hop, Probe } from "../protocol";
import { initialState, type TraceState } from "../reducer";
import {
  buildRows, delayText, groupHops, hasSolidLocation, isIpLiteral, isPrivateIp, isQuiet, medianRtt, placeLabel,
  quietRunTitle, summaryLine, trailingStopKey,
} from "./rows";

const probes = (...ms: (number | null)[]): Probe[] => ms.map((rttMs) => ({ ip: rttMs === null ? null : "9.9.9.9", rttMs }));
const hop = (ttl: number, over: Partial<Hop> = {}): Hop => ({
  ttl, probes: probes(10, 12, 11), ip: "9.9.9.9", host: null, asn: null, org: null,
  lat: 1, lon: 2, city: null, geoSource: "api", annotations: [], ...over,
});
const quiet = (ttl: number): Hop => hop(ttl, { ip: null, probes: probes(null, null, null), geoSource: "estimated" });

describe("medianRtt", () => {
  it.each([
    [[10, 30, 20], 20],
    [[10, 20], 15],
    [[7], 7],
    [[10, null, 30], 20],
  ] as const)("%j → %s", (xs, expected) => expect(medianRtt(probes(...xs))).toBe(expected));
  it("is null with no replies", () => {
    expect(medianRtt(probes(null, null))).toBeNull();
    expect(medianRtt([])).toBeNull();
  });
});

describe("delayText", () => {
  it.each([[10, "10 ms"], [10.4, "10 ms"], [10.5, "11 ms"], [0.6, "1 ms"], [0.4, "<1 ms"], [0, "<1 ms"], [1234.5, "1235 ms"]])(
    "%s → %s", (ms, text) => expect(delayText(ms)).toBe(text),
  );
});

describe("isPrivateIp", () => {
  it.each([
    "10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1", "100.127.255.1",
    "169.254.1.1", "127.0.0.1", "::1", "fd12:3456::1", "fc00::1", "fe80::1", "FE80::abcd", "fe80::1%en0",
  ])("%s is private", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "100.63.0.1", "192.169.0.1", "2001:db8::1", "2606:4700::1111", "fec0::1"])(
    "%s is public", (ip) => expect(isPrivateIp(ip)).toBe(false),
  );
  it("treats null as not private", () => expect(isPrivateIp(null)).toBe(false));
});

describe("isIpLiteral", () => {
  it.each(["1.1.1.1", "255.255.255.255", "2606:4700::1111", "::1"])("%s", (s) => expect(isIpLiteral(s)).toBe(true));
  it.each(["example.com", "1.1.1", "256.1.1.1", "1.1.1.1.1", "", "a:b"])("%s is not", (s) => expect(isIpLiteral(s)).toBe(false));
});

describe("hasSolidLocation", () => {
  it.each([["api", true], ["hostname", true], ["local", true], ["estimated", false]] as const)("%s → %s", (src, solid) =>
    expect(hasSolidLocation(hop(1, { geoSource: src }))).toBe(solid));
});

describe("placeLabel", () => {
  it("calls hop 1 on a private IP 'Your router'", () => {
    expect(placeLabel(hop(1, { ip: "192.168.1.1" }))).toBe("Your router");
  });
  it("adds the place to the router when known", () => {
    expect(placeLabel(hop(1, { ip: "192.168.1.1", city: "Toronto", geoSource: "local" }))).toBe("Your router · Toronto");
  });
  it("lets CGNAT hops past the first fall through to the network/place label", () => {
    expect(placeLabel(hop(3, { ip: "100.64.1.1", asn: 701, org: "Verizon", city: "Boston" }))).toBe("Verizon · Boston");
    expect(placeLabel(hop(3, { ip: "100.64.1.1", city: "Boston" }))).toBe("Boston");
    expect(placeLabel(hop(3, { ip: "100.64.1.1" }))).toBe("100.64.1.1");
    expect(placeLabel(hop(1, { ip: "100.64.1.1" }))).toBe("Your router");
    expect(placeLabel(hop(3, { ip: "10.1.1.1" }))).toBe("Local network");
  });
  it("calls other private hops 'Local network'", () => {
    expect(placeLabel(hop(2, { ip: "10.0.0.1" }))).toBe("Local network");
    expect(placeLabel(hop(1, { ip: "8.8.8.8", asn: 15169, org: "GOOGLE", city: "Mountain View" }))).not.toBe("Your router");
  });
  it("joins short network name and city for public hops", () => {
    expect(placeLabel(hop(4, { asn: 701, org: "UUNET - Verizon Business, US", city: "New York" }))).toBe("Verizon · New York");
  });
  it("prefixes an estimated city with ≈", () => {
    expect(placeLabel(hop(4, { asn: 701, org: "UUNET", city: "New York", geoSource: "estimated" }))).toBe("Verizon · ≈ New York");
    expect(placeLabel(hop(1, { ip: "192.168.1.1", city: "Toronto", geoSource: "estimated" }))).toBe("Your router · ≈ Toronto");
  });
  it("falls back to network only, city only, then the IP", () => {
    expect(placeLabel(hop(4, { asn: 701, org: "Verizon" }))).toBe("Verizon");
    expect(placeLabel(hop(4, { city: "Chicago" }))).toBe("Chicago");
    expect(placeLabel(hop(4, { ip: "203.0.113.9" }))).toBe("203.0.113.9");
  });
});

describe("isQuiet / groupHops", () => {
  it("quiet means no probe got a reply", () => {
    expect(isQuiet(quiet(3))).toBe(true);
    expect(isQuiet(hop(3, { probes: probes(null, 5, null) }))).toBe(false);
  });

  it("returns [] for no hops", () => expect(groupHops([])).toEqual([]));

  it("keeps responding hops as individual rows with stable keys", () => {
    const rows = groupHops([hop(1), hop(2)]);
    expect(rows.map((r) => r.key)).toEqual(["h1", "h2"]);
    expect(rows.every((r) => r.kind === "hop")).toBe(true);
  });

  it("collapses a run of one", () => {
    const rows = groupHops([hop(1), quiet(2), hop(3)]);
    expect(rows.map((r) => r.key)).toEqual(["h1", "q2", "h3"]);
    expect(rows[1]).toMatchObject({ kind: "quiet", ttls: [2] });
  });

  it("collapses a run of ten", () => {
    const hops = [hop(1), ...Array.from({ length: 10 }, (_, i) => quiet(i + 2)), hop(12)];
    const rows = groupHops(hops);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ kind: "quiet", key: "q2", ttls: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
  });

  it("keeps a growing run's key", () => {
    const before = groupHops([hop(1), quiet(2), quiet(3)]);
    const after = groupHops([hop(1), quiet(2), quiet(3), quiet(4)]);
    expect(before[1]!.key).toBe("q2");
    expect(after[1]).toMatchObject({ key: "q2", ttls: [2, 3, 4] });
  });

  it("splits a run when a late reply arrives for a hop in the middle", () => {
    const rows = groupHops([hop(1), quiet(2), quiet(3), hop(4), quiet(5), quiet(6)]);
    const split = groupHops([hop(1), quiet(2), hop(3), quiet(4), quiet(5)]);
    expect(rows.map((r) => r.key)).toEqual(["h1", "q2", "h4", "q5"]);
    expect(split.map((r) => r.key)).toEqual(["h1", "q2", "h3", "q4"]);
    expect(split[3]).toMatchObject({ kind: "quiet", ttls: [4, 5] });
  });

  it("only merges consecutive ttls: a gap in the list starts a new run", () => {
    const rows = groupHops([hop(1), quiet(2), quiet(4), quiet(5)]);
    expect(rows.map((r) => r.key)).toEqual(["h1", "q2", "q4"]);
    expect(rows[2]).toMatchObject({ kind: "quiet", ttls: [4, 5] });
  });

  it("handles leading and trailing runs", () => {
    const rows = groupHops([quiet(1), quiet(2), hop(3), quiet(4), quiet(5)]);
    expect(rows.map((r) => (r.kind === "quiet" ? r.ttls : r.hop.ttl))).toEqual([[1, 2], 3, [4, 5]]);
  });
});

describe("summaryLine", () => {
  const withHops = (hops: Hop[], reached: boolean | null = true): TraceState => ({ ...initialState, status: "done", target: "x", hops, reached });
  it("reports hops, distinct networks and the last responding hop's typical delay", () => {
    const s = withHops([
      hop(1, { ip: "192.168.1.1" }),
      hop(2, { asn: 701, org: "Verizon", probes: probes(8, 9, 10) }),
      hop(3, { asn: 701, org: "UUNET" }),
      quiet(4),
      hop(5, { asn: 15169, org: "GOOGLE", probes: probes(20, 24, 22) }),
    ]);
    expect(summaryLine(s)).toBe("5 hops · 2 networks · 22 ms");
  });
  it("falls back to the short name when the ASN is unknown, and ignores private hops", () => {
    const s = withHops([
      hop(1, { ip: "10.0.0.1" }),
      hop(2, { asn: null, org: "Acme Networks Ltd" }),
      hop(3, { asn: null, org: "Acme Networks Ltd" }),
    ]);
    expect(summaryLine(s)).toBe("3 hops · 1 network · 11 ms");
  });
  it("counts one network when several ASNs share a short name (AS7922 + AS33651 are both Comcast)", () => {
    const s = withHops([hop(1, { asn: 7922, org: "COMCAST-7922" }), hop(2, { asn: 33651, org: "COMCAST-33651" })]);
    expect(summaryLine(s)).toBe("2 hops · 1 network · 11 ms");
  });
  it("counts distinct unknown ASNs separately", () => {
    const s = withHops([hop(1, { asn: 64500, org: null }), hop(2, { asn: 64501, org: null })]);
    expect(summaryLine(s)).toBe("2 hops · 2 networks · 11 ms");
  });
  it("singularises one hop and omits unknowns", () => {
    expect(summaryLine(withHops([hop(1, { ip: "192.168.1.1" })]))).toBe("1 hop · 11 ms");
    expect(summaryLine(withHops([quiet(1)]))).toBe("1 hop");
  });
  it("on an unreached trace counts hops only up to the last responding hop and shows no delay", () => {
    const s = withHops([
      hop(1, { ip: "192.168.1.1" }),
      hop(2, { asn: 701, org: "Verizon" }),
      quiet(3), quiet(4), quiet(5),
    ], false);
    expect(summaryLine(s)).toBe("2 hops · 1 network");
  });
  it("on an unreached trace with no replies at all, still counts the hops tried", () => {
    expect(summaryLine(withHops([quiet(1), quiet(2)], false))).toBe("2 hops");
  });
});

describe("trailingStopKey", () => {
  const done = (hops: Hop[], reached: boolean | null, endReason: TraceState["endReason"] = reached === false ? "limit" : "reached"): TraceState =>
    ({ ...initialState, status: "done", target: "x", hops, reached, endReason });
  it("names the trailing quiet run of a trace that ran out of hops", () => {
    const s = done([hop(1), quiet(2), hop(3), quiet(4), quiet(5)], false);
    expect(trailingStopKey(s, groupHops(s.hops))).toBe("q4");
  });
  it("is null when the trace reached, is still running, or does not end quiet", () => {
    const hops = [hop(1), quiet(2)];
    expect(trailingStopKey(done(hops, true), groupHops(hops))).toBeNull();
    expect(trailingStopKey({ ...done(hops, null), status: "running" }, groupHops(hops))).toBeNull();
    const ends = [quiet(1), hop(2)];
    expect(trailingStopKey(done(ends, false), groupHops(ends))).toBeNull();
  });
  it("keys on the limit end reason: a quiet or cancelled finish has its own ending", () => {
    const hops = [hop(1), quiet(2)];
    expect(trailingStopKey(done(hops, false, "quiet"), groupHops(hops))).toBeNull();
    expect(trailingStopKey(done(hops, false, "limit"), groupHops(hops))).toBe("q2");
  });
});

const reachable: Destination = {
  ip: "104.16.1.1", reachable: true, port: 443, rttMs: 18.4, host: null, asn: 13335, org: "CLOUDFLARENET",
  lat: 40.7, lon: -74, city: "New York", geoSource: "api",
};
const unreachable: Destination = {
  ip: "203.0.113.9", reachable: false, port: null, rttMs: null, host: null, asn: null, org: null,
  lat: null, lon: null, city: null, geoSource: "estimated",
};
const verizon = (ttl: number): Hop => hop(ttl, { asn: 701, org: "Verizon" });
const cloudflare = (ttl: number): Hop => hop(ttl, { asn: 13335, org: "CLOUDFLARENET" });
const finished = (hops: Hop[], over: Partial<TraceState> = {}): TraceState =>
  ({ ...initialState, status: "done", target: "x", hops, reached: false, endReason: "limit", ...over });

describe("quietRunTitle", () => {
  it.each<[string, number, Hop | null, Hop | null, string]>([
    ["same network", 4, verizon(2), verizon(7), "4 routers inside Verizon's network"],
    ["different networks", 3, verizon(2), cloudflare(6), "3 routers between Verizon and Cloudflare"],
    ["a known name ending in s (Lumen) takes a bare apostrophe", 2, hop(1, { asn: 3356, org: "LUMEN" }), hop(4, { asn: 3356 }), "2 routers inside Lumen's network"],
    ["a name that really ends in s", 2, hop(1, { asn: 64500, org: "Acme Hosts" }), hop(4, { asn: 64500, org: "Acme Hosts" }), "2 routers inside Acme Hosts' network"],
    ["singular, same network", 1, verizon(2), verizon(4), "1 router inside Verizon's network"],
    ["singular, different networks", 1, verizon(2), cloudflare(4), "1 router between Verizon and Cloudflare"],
    ["unknown network before", 2, hop(1), verizon(4), "2 routers stayed quiet"],
    ["unknown network after", 2, verizon(1), hop(4), "2 routers stayed quiet"],
    ["no neighbour before", 3, null, verizon(4), "3 routers stayed quiet"],
    ["no neighbour after", 1, verizon(1), null, "1 router stayed quiet"],
  ])("%s", (_name, n, before, after, want) => {
    expect(quietRunTitle(n, before, after)).toBe(want);
  });
});

describe("buildRows with doubted locations", () => {
  it("attaches the doubt to its hop row", () => {
    const h = { ...hop(2), geoSource: "estimated" as const, lat: null, lon: null, city: null };
    const doubt = { place: "Brisbane", rttMs: 10 };
    const rows = buildRows({ ...initialState, hops: [h], doubts: new Map([[2, doubt]]), destinationDoubt: null });
    expect(rows[0]).toMatchObject({ kind: "hop", doubt });
  });
});

describe("placeLabel for a doubted hop", () => {
  it("marks the network with a bare ≈ since no place is known", () => {
    const h = { ...hop(2), asn: 701, org: "UUNET - Verizon Business, US", geoSource: "estimated" as const, city: null, lat: null, lon: null };
    expect(placeLabel(h, true)).toBe("Verizon · ≈");
    expect(placeLabel(h)).toBe("Verizon");
  });
});

describe("buildRows", () => {
  it("names a gap between two responding hops by its neighbours", () => {
    const rows = buildRows(finished([verizon(1), quiet(2), quiet(3), quiet(4), verizon(5), quiet(6), cloudflare(7)], { reached: true, endReason: "reached" }));
    const titles = rows.flatMap((r) => (r.kind === "quiet" ? [r.title] : []));
    expect(titles).toEqual(["3 routers inside Verizon's network", "1 router between Verizon and Cloudflare"]);
  });
  it("leaves a run before the first reply and an unfinished trailing run on the default copy", () => {
    const rows = buildRows(finished([quiet(1), quiet(2), verizon(3), quiet(4)]));
    expect(rows.flatMap((r) => (r.kind === "quiet" ? [r.title] : []))).toEqual(["2 routers stayed quiet", "1 router stayed quiet"]);
  });
  it("matches groupHops apart from the gap names for limit and reached finishes", () => {
    for (const over of [{ endReason: "limit" as const }, { endReason: "reached" as const, reached: true }]) {
      const s = finished([verizon(1), quiet(2), verizon(3), quiet(4), quiet(5)], over);
      expect(buildRows(s).map((r) => ({ kind: r.kind, key: r.key }))).toEqual(groupHops(s.hops).map((r) => ({ kind: r.kind, key: r.key })));
    }
  });
  it("replaces the trailing quiet run of a quiet finish with a reachable destination row", () => {
    const s = finished([verizon(1), verizon(2), quiet(3), quiet(4), quiet(5), quiet(6), quiet(7)], { endReason: "quiet", destination: reachable });
    const rows = buildRows(s);
    expect(rows.map((r) => r.kind)).toEqual(["hop", "hop", "destination"]);
    expect(rows.at(-1)).toMatchObject({ kind: "destination", key: "dest", destination: reachable, ttl: 8, ttls: [3, 4, 5, 6, 7] });
  });
  it("replaces it with a closing row naming the last network when the destination does not answer", () => {
    const s = finished([hop(1, { ip: "192.168.1.1" }), verizon(2), quiet(3), quiet(4), quiet(5), quiet(6), quiet(7)], { endReason: "quiet", destination: unreachable });
    const rows = buildRows(s);
    expect(rows.map((r) => r.kind)).toEqual(["hop", "hop", "end"]);
    expect(rows.at(-1)).toMatchObject({ kind: "end", key: "end", pastLabel: "Verizon", ttls: [3, 4, 5, 6, 7] });
  });
  it("gives a located destination that does not answer a destination row, marked as not answering", () => {
    const placed: Destination = { ...unreachable, lat: 41.9, lon: -87.6, city: "Chicago", geoSource: "api" };
    const s = finished([verizon(1), verizon(2), quiet(3), quiet(4)], { endReason: "quiet", destination: placed });
    const rows = buildRows(s);
    expect(rows.map((r) => r.kind)).toEqual(["hop", "hop", "destination"]);
    expect(rows.at(-1)).toMatchObject({ kind: "destination", answers: false, ttl: 5, ttls: [3, 4] });
    expect(buildRows({ ...s, destination: reachable }).at(-1)).toMatchObject({ answers: true });
  });
  it("closes with an end row when a quiet finish carries no destination at all", () => {
    const rows = buildRows(finished([verizon(1), quiet(2)], { endReason: "quiet", destination: null }));
    expect(rows.at(-1)).toMatchObject({ kind: "end" });
  });
  it("keeps the trailing run while the trace is still running", () => {
    const rows = buildRows({ ...finished([verizon(1), quiet(2)]), status: "running", endReason: null });
    expect(rows.map((r) => r.kind)).toEqual(["hop", "quiet"]);
  });
  it("gives the destination row a scene ttl only when the scene will draw it", () => {
    const base = finished([verizon(1), quiet(2)], { endReason: "quiet" });
    expect(buildRows({ ...base, destination: reachable }).at(-1)).toMatchObject({ ttl: 3 });
    expect(buildRows({ ...base, destination: { ...reachable, lat: null, lon: null } }).at(-1)).toMatchObject({ ttl: null });
  });
});

describe("summaryLine for quiet finishes", () => {
  it("reads N+ hops when the destination answers: hops through the last reply, plus one", () => {
    const s = finished([hop(1, { ip: "192.168.1.1" }), verizon(2), quiet(3), quiet(4), quiet(5), quiet(6), quiet(7)], { endReason: "quiet", destination: reachable });
    expect(summaryLine(s)).toBe("3+ hops · 1 network");
  });
  it("stays as before when the destination does not answer", () => {
    const s = finished([hop(1, { ip: "192.168.1.1" }), verizon(2), quiet(3), quiet(4), quiet(5), quiet(6), quiet(7)], { endReason: "quiet", destination: unreachable });
    expect(summaryLine(s)).toBe("2 hops · 1 network");
  });
  it("reads N+ hops for a located destination that does not answer", () => {
    const placed: Destination = { ...unreachable, lat: 41.9, lon: -87.6, city: "Chicago", geoSource: "api" };
    const s = finished([hop(1, { ip: "192.168.1.1" }), verizon(2), quiet(3), quiet(4)], { endReason: "quiet", destination: placed });
    expect(summaryLine(s)).toBe("3+ hops · 1 network");
  });
});
