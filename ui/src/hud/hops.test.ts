// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Hop } from "../protocol";
import { badgeFor, hopRow, rttText } from "./hops";

const hop = (over: Partial<Hop> = {}): Hop => ({
  ttl: 3, probes: [{ ip: "1.1.1.1", rttMs: 12.34 }, { ip: "1.1.1.1", rttMs: 15 }, { ip: null, rttMs: null }],
  ip: "1.1.1.1", host: "one.one.one.one", asn: 13335, org: "Cloudflare", lat: 1, lon: 2, city: "SF",
  geoSource: "api", annotations: [], ...over,
});

describe("badgeFor", () => {
  it.each([["api", "measured"], ["hostname", "measured"], ["local", "measured"], ["estimated", "estimated"]] as const)(
    "%s → %s", (src, badge) => expect(badgeFor(src)).toBe(badge),
  );
});

describe("rttText", () => {
  it("formats probes, using * for timeouts", () => {
    expect(rttText(hop().probes)).toBe("12.3 ms · 15.0 ms · *");
  });
});

describe("hopRow", () => {
  it("renders ttl, ip, host, ASN/org, rtts and badge", () => {
    const el = hopRow(document, hop(), () => {});
    expect(el.dataset.ttl).toBe("3");
    expect(el.textContent).toContain("3");
    expect(el.textContent).toContain("1.1.1.1");
    expect(el.textContent).toContain("one.one.one.one");
    expect(el.textContent).toContain("AS13335 Cloudflare");
    expect(el.querySelector(".badge")!.textContent).toBe("measured");
    expect(el.querySelector(".badge")!.className).toContain("measured");
  });
  it("shows * and an estimated badge for an all-timeout hop", () => {
    const el = hopRow(document, hop({ ip: null, host: null, asn: null, org: null, geoSource: "estimated",
      probes: [{ ip: null, rttMs: null }, { ip: null, rttMs: null }] }), () => {});
    expect(el.querySelector(".rtt")!.textContent).toBe("* · *");
    expect(el.querySelector(".ip")!.textContent).toBe("*");
    expect(el.querySelector(".badge")!.textContent).toBe("estimated");
  });
  it("escapes untrusted strings", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const el = hopRow(document, hop({ host: evil, org: evil }), () => {});
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain(evil);
  });
  it("click and Enter focus the hop", () => {
    const got: number[] = [];
    const el = hopRow(document, hop(), (t) => got.push(t));
    el.click();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(got).toEqual([3, 3]);
  });
});
