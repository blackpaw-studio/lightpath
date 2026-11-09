// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Destination, Hop } from "../protocol";
import {
  destinationRowEl, DESTINATION_SUBTITLE, endRowEl, hopRowEl, quietRowEl, rowEl, rttText, QUIET_SUBTITLE, STOPPED_SUBTITLE,
  type RowHandlers,
} from "./hops";
import type { Row } from "./rows";

const hop = (over: Partial<Hop> = {}): Hop => ({
  ttl: 3, probes: [{ ip: "1.1.1.1", rttMs: 12.34 }, { ip: "1.1.1.1", rttMs: 15 }, { ip: "1.1.1.1", rttMs: 9 }],
  ip: "1.1.1.1", host: "one.one.one.one", asn: 13335, org: "Cloudflare, Inc.", lat: 1, lon: 2, city: "San Francisco",
  geoSource: "api", annotations: [], ...over,
});
const handlers = (): RowHandlers => ({ onToggle: vi.fn(), onFocus: vi.fn() });
const hopRow = (h: Hop, expanded = false, hs = handlers()) =>
  hopRowEl(document, { kind: "hop", key: "h" + h.ttl, hop: h } as Extract<Row, { kind: "hop" }>, expanded, hs);
const quietRow = (ttls: number[], expanded = false, hs = handlers(), stopped = false) =>
  quietRowEl(document, { kind: "quiet", key: "q" + ttls[0], ttls }, expanded, hs, stopped);
const head = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="button"]')!;
const details = (el: HTMLElement) => el.querySelector<HTMLElement>(".details")!;

describe("rttText", () => {
  it("formats probes, using * for timeouts", () => {
    expect(rttText([{ ip: "1.1.1.1", rttMs: 12.34 }, { ip: "1.1.1.1", rttMs: 15 }, { ip: null, rttMs: null }])).toBe(
      "12.3 ms · 15.0 ms · *",
    );
  });
});

describe("hop row", () => {
  it("shows place, short network and one median delay, no raw IP/AS up front", () => {
    const el = hopRow(hop());
    expect(el.dataset.ttl).toBe("3");
    expect(el.querySelector(".place")!.textContent).toBe("Cloudflare · San Francisco");
    expect(el.querySelector(".delay")!.textContent).toBe("12 ms");
    expect(head(el).textContent).not.toContain("1.1.1.1");
    expect(head(el).textContent).not.toContain("AS13335");
  });
  it("has no MEASURED/ESTIMATED badge", () => {
    expect(hopRow(hop()).querySelector(".badge")).toBeNull();
  });
  it("uses a solid dot for a measured location and a hollow dot plus ≈ for an estimate", () => {
    const solid = hopRow(hop({ geoSource: "hostname" }));
    expect(solid.querySelector(".dot")!.classList.contains("solid")).toBe(true);
    expect(solid.querySelector(".place")!.textContent).not.toContain("≈");
    const hollow = hopRow(hop({ geoSource: "estimated" }));
    expect(hollow.querySelector(".dot")!.classList.contains("hollow")).toBe(true);
    expect(hollow.querySelector(".place")!.textContent).toBe("Cloudflare · ≈ San Francisco");
  });
  it("names private hops plainly", () => {
    expect(hopRow(hop({ ttl: 1, ip: "192.168.1.1", asn: null, org: null, city: null })).querySelector(".place")!.textContent)
      .toBe("Your router");
    expect(hopRow(hop({ ttl: 2, ip: "10.1.1.1", asn: null, org: null, city: null })).querySelector(".place")!.textContent)
      .toBe("Local network");
  });
  it("keeps the technical fields in a hidden details block", () => {
    const el = hopRow(hop());
    const d = details(el);
    expect(d.hidden).toBe(true);
    expect(d.textContent).toContain("1.1.1.1");
    expect(d.textContent).toContain("one.one.one.one");
    expect(d.textContent).toContain("AS13335 Cloudflare, Inc.");
    expect(d.textContent).toContain("12.3 ms · 15.0 ms · 9.0 ms");
    expect(d.textContent).toContain("Measured");
    expect(hopRow(hop({ geoSource: "estimated" })).querySelector(".details")!.textContent).toContain("Estimated");
  });
  it("omits detail lines it has no data for", () => {
    const d = details(hopRow(hop({ host: null, asn: null, org: null })));
    expect(d.textContent).not.toContain("Host");
    expect(d.textContent).not.toContain("Network");
  });
  it("renders initially expanded when asked", () => {
    const el = hopRow(hop(), true);
    expect(head(el).getAttribute("aria-expanded")).toBe("true");
    expect(details(el).hidden).toBe(false);
  });
  it("escapes untrusted strings", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const el = hopRow(hop({ host: evil, org: evil, city: evil }), true);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain(evil);
  });
  it("is a keyboard-operable button with aria-expanded wired to the details", () => {
    const el = hopRow(hop());
    const b = head(el);
    expect(b.tabIndex).toBe(0);
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe(details(el).id);
  });
  it.each([
    ["click", () => new MouseEvent("click", { bubbles: true })],
    ["Enter", () => new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })],
    ["Space", () => new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })],
  ])("%s toggles the details, reports the toggle and focuses the hop", (_n, mk) => {
    const hs = handlers();
    const el = hopRow(hop(), false, hs);
    head(el).dispatchEvent(mk());
    expect(head(el).getAttribute("aria-expanded")).toBe("true");
    expect(details(el).hidden).toBe(false);
    expect(hs.onToggle).toHaveBeenCalledWith("h3", true);
    expect(hs.onFocus).toHaveBeenCalledWith(3);
    head(el).dispatchEvent(mk());
    expect(head(el).getAttribute("aria-expanded")).toBe("false");
    expect(hs.onToggle).toHaveBeenLastCalledWith("h3", false);
  });
  it("animates the reveal only after a user toggle, never on a render", () => {
    const rendered = hopRow(hop(), true);
    expect(rendered.classList.contains("opening")).toBe(false);
    const el = hopRow(hop());
    head(el).click();
    expect(el.classList.contains("opening")).toBe(true);
    details(el).dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(el.classList.contains("opening")).toBe(false);
    head(el).click(); // closing never animates
    expect(el.classList.contains("opening")).toBe(false);
  });
  it("prevents the page scroll on Space", () => {
    const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    head(hopRow(hop())).dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
  it("ignores other keys", () => {
    const hs = handlers();
    head(hopRow(hop(), false, hs)).dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(hs.onToggle).not.toHaveBeenCalled();
  });
});

describe("quiet row", () => {
  it("summarises the run with a dashed connector, not a hop dot", () => {
    const el = quietRow([4, 5, 6]);
    expect(el.classList.contains("quiet")).toBe(true);
    expect(el.dataset.ttls).toBe("4 5 6");
    expect(el.querySelector(".place")!.textContent).toBe("3 routers stayed quiet");
    expect(el.textContent).toContain("Many networks hide their routers; the path continues.");
    expect(el.querySelector(".connector")).not.toBeNull();
    expect(el.querySelector(".dot")).toBeNull();
  });
  it("says the trace stopped when this is the trailing run of an unreached trace", () => {
    const el = quietRow([4, 5], false, handlers(), true);
    expect(el.querySelector(".subtitle")!.textContent).toBe(STOPPED_SUBTITLE);
    expect(STOPPED_SUBTITLE).toBe("The trace stopped here; the destination didn't answer.");
    expect(quietRow([4, 5]).querySelector(".subtitle")!.textContent).toBe(QUIET_SUBTITLE);
  });
  it("uses the singular for one router", () => {
    expect(quietRow([2]).querySelector(".place")!.textContent).toBe("1 router stayed quiet");
  });
  it("lists the hop numbers when expanded, and only toggles (no scene focus)", () => {
    const hs = handlers();
    const el = quietRow([2, 3], false, hs);
    expect(details(el).hidden).toBe(true);
    expect(details(el).querySelector("dt")!.textContent).toBe("Hops");
    expect(details(el).querySelector("dd")!.textContent).toBe("2, 3");
    head(el).click();
    expect(details(el).hidden).toBe(false);
    expect(head(el).getAttribute("aria-expanded")).toBe("true");
    expect(hs.onToggle).toHaveBeenCalledWith("q2", true);
    expect(hs.onFocus).not.toHaveBeenCalled();
  });
  it("is keyboard operable", () => {
    const el = quietRow([2]);
    head(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(head(el).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("named quiet row", () => {
  it("shows the title built from the neighbouring networks instead of the generic copy", () => {
    const el = quietRowEl(document, { kind: "quiet", key: "q4", ttls: [4, 5, 6], title: "3 routers inside Verizon's network" }, false, handlers());
    expect(el.querySelector(".place")!.textContent).toBe("3 routers inside Verizon's network");
    expect(el.dataset.ttls).toBe("4 5 6");
    expect(details(el).querySelector("dd")!.textContent).toBe("4, 5, 6");
  });
});

const dest: Destination = {
  ip: "104.16.1.1", reachable: true, port: 443, rttMs: 18.4, host: "edge.example.net", asn: 13335, org: "CLOUDFLARENET",
  lat: 40.7, lon: -74, city: "New York", geoSource: "api",
};
const destRow = (d: Destination, ttl: number | null, hs = handlers()) =>
  destinationRowEl(document, { kind: "destination", key: "dest", destination: d, ttl, ttls: [5, 6, 7] }, false, hs);

describe("destination row", () => {
  it("reads Destination · network · place · delay with the direct-answer note", () => {
    const el = destRow(dest, 8);
    expect(el.querySelector(".place")!.textContent).toBe("Destination · Cloudflare · New York · 18 ms");
    expect(el.querySelector(".subtitle")!.textContent).toBe(DESTINATION_SUBTITLE);
    expect(DESTINATION_SUBTITLE).toBe("Answers directly; routers near it stay quiet.");
  });
  it("prefixes an estimated place with ≈ and drops parts it lacks", () => {
    expect(destRow({ ...dest, geoSource: "estimated" }, 8).querySelector(".place")!.textContent).toBe("Destination · Cloudflare · ≈ New York · 18 ms");
    expect(destRow({ ...dest, org: null, asn: null, city: null, lat: null, lon: null }, null).querySelector(".place")!.textContent).toBe("Destination · 18 ms");
  });
  it("lists IP, TCP port and delay in the details", () => {
    const text = details(destRow(dest, 8)).textContent!;
    expect(text).toContain("104.16.1.1");
    expect(text).toContain("TCP port 443");
    expect(text).toContain("18 ms");
  });
  it("focuses the scene's destination entry when it has one", () => {
    const hs = handlers();
    const el = destRow(dest, 8, hs);
    expect(el.dataset.ttl).toBe("8");
    head(el).click();
    expect(hs.onFocus).toHaveBeenCalledWith(8);
  });
  it("carries the silent hops it replaced, so selecting those scene nodes can highlight it", () => {
    expect(destRow(dest, 8).dataset.ttls).toBe("5 6 7");
    expect(destRow(dest, null).dataset.ttls).toBe("5 6 7");
  });
  it("only toggles when the scene has no entry for it", () => {
    const hs = handlers();
    const el = destRow(dest, null, hs);
    expect(el.dataset.ttl).toBeUndefined();
    head(el).click();
    expect(hs.onFocus).not.toHaveBeenCalled();
    expect(hs.onToggle).toHaveBeenCalledWith("dest", true);
  });
  it("escapes untrusted strings", () => {
    const el = destRow({ ...dest, org: "<img src=x onerror=alert(1)>", asn: null, city: "<b>x</b>" }, 8);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
  });
});

describe("closing row", () => {
  const end = (hs = handlers()) =>
    endRowEl(document, { kind: "end", key: "end", ttls: [3, 4], pastLabel: "Verizon · New York", destination: null }, false, hs);
  it("says the destination does not answer and where the path ends", () => {
    const el = end();
    expect(el.querySelector(".place")!.textContent).toBe("The destination doesn't answer traces");
    expect(el.querySelector(".subtitle")!.textContent).toBe("The path ends somewhere past Verizon · New York.");
    expect(el.querySelector(".dot")).toBeNull();
  });
  it("lists the silent hops in its details and never moves the scene", () => {
    const hs = handlers();
    const el = end(hs);
    expect(details(el).textContent).toContain("3, 4");
    head(el).click();
    expect(hs.onFocus).not.toHaveBeenCalled();
  });
  it("rowEl dispatches every row kind", () => {
    const hs = handlers();
    expect(rowEl(document, { kind: "end", key: "end", ttls: [], pastLabel: "x", destination: null }, false, hs).dataset.key).toBe("end");
    expect(rowEl(document, { kind: "destination", key: "dest", destination: dest, ttl: 2, ttls: [] }, false, hs).dataset.key).toBe("dest");
  });
});
