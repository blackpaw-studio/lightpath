import { describe, expect, it } from "vitest";
import type { Hop, Probe } from "../protocol";
import { initialState, type TraceState } from "../reducer";
import {
  delayText, groupHops, hasSolidLocation, isIpLiteral, isPrivateIp, isQuiet, medianRtt, placeLabel, summaryLine,
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

  it("handles leading and trailing runs", () => {
    const rows = groupHops([quiet(1), quiet(2), hop(3), quiet(4), quiet(5)]);
    expect(rows.map((r) => (r.kind === "quiet" ? r.ttls : r.hop.ttl))).toEqual([[1, 2], 3, [4, 5]]);
  });
});

describe("summaryLine", () => {
  const withHops = (hops: Hop[]): TraceState => ({ ...initialState, status: "done", target: "x", hops });
  it("reports hops, distinct networks and the last responding hop's typical delay", () => {
    const s = withHops([
      hop(1, { ip: "192.168.1.1" }),
      hop(2, { asn: 701, org: "Verizon", probes: probes(8, 9, 10) }),
      hop(3, { asn: 701, org: "UUNET" }),
      quiet(4),
      hop(5, { asn: 15169, org: "GOOGLE", probes: probes(20, 24, 22) }),
      quiet(6),
    ]);
    expect(summaryLine(s)).toBe("6 hops · 2 networks · 22 ms");
  });
  it("falls back to the short name when the ASN is unknown, and ignores private hops", () => {
    const s = withHops([
      hop(1, { ip: "10.0.0.1" }),
      hop(2, { asn: null, org: "Acme Networks Ltd" }),
      hop(3, { asn: null, org: "Acme Networks Ltd" }),
    ]);
    expect(summaryLine(s)).toBe("3 hops · 1 network · 11 ms");
  });
  it("singularises one hop and omits unknowns", () => {
    expect(summaryLine(withHops([hop(1, { ip: "192.168.1.1" })]))).toBe("1 hop · 11 ms");
    expect(summaryLine(withHops([quiet(1)]))).toBe("1 hop");
  });
});
