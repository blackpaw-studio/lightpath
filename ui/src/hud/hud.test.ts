// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../reducer";
import { mount } from "./hud";
import type { Destination, Hop } from "../protocol";

const hop = (ttl: number, over: Partial<Hop> = {}): Hop => ({
  ttl, probes: [{ ip: "9.9.9.9", rttMs: ttl * 10 }], ip: "9.9.9.9", host: null, asn: null, org: null,
  lat: 0, lon: 0, city: null, geoSource: "api", annotations: [], ...over,
});
const origin = { publicIp: "1.2.3.4", lat: 0, lon: 0, city: null, asn: null, org: null };
const running = [
  { type: "trace.started", target: "example.com", resolvedIp: "93.184.216.34", origin } as const,
  { type: "hop", ...hop(1) } as const, { type: "hop", ...hop(2) } as const,
].reduce(reduce, initialState);

const setup = (hosted = true) => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const h = { onTrace: vi.fn(), onCancel: vi.fn(), onFocusHop: vi.fn(), onDive: vi.fn(), onSurface: vi.fn() };
  return { root, h, hud: mount(root, h, { hosted }) };
};
const connected = { status: "connected", failures: 0, slow: false } as const;

describe("hud", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("submits a trimmed target", () => {
    const { root, h } = setup();
    root.querySelector<HTMLInputElement>("input")!.value = "  example.com ";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(h.onTrace).toHaveBeenCalledWith("example.com");
  });
  it("ignores an empty target", () => {
    const { root, h } = setup();
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(h.onTrace).not.toHaveBeenCalled();
  });
  it("renders hops in order and keeps rows stable across renders", () => {
    const { root, hud } = setup();
    hud.render(running, connected);
    const rows = [...root.querySelectorAll<HTMLElement>(".hop")];
    expect(rows.map((r) => r.dataset.ttl)).toEqual(["1", "2"]);
    hud.render(running, connected);
    expect(root.querySelectorAll(".hop")).toHaveLength(2);
  });
  it("shows connection status and a cancel button while running", () => {
    const { root, hud, h } = setup();
    hud.render(running, connected);
    expect(root.querySelector(".chip")!.textContent).toBe("connected");
    const cancel = root.querySelector<HTMLButtonElement>("button.trace")!;
    expect(cancel.textContent).toBe("Cancel");
    cancel.click();
    expect(h.onCancel).toHaveBeenCalled();
  });
  it("disables tracing while disconnected", () => {
    const { root, hud } = setup();
    hud.render(initialState, { status: "disconnected", failures: 1, slow: true });
    expect(root.querySelector<HTMLButtonElement>("button.trace")!.disabled).toBe(true);
  });
  it("shows the install panel only on the hosted page once the agent is slow to answer", () => {
    const a = setup(true);
    const hidden = () => a.root.querySelector(".install")!.hasAttribute("hidden");
    a.hud.render(initialState, { status: "connecting", failures: 0, slow: false });
    expect(hidden()).toBe(true);
    // A hung dial never closes: failures stays 0 but slow is set.
    a.hud.render(initialState, { status: "connecting", failures: 0, slow: true });
    expect(hidden()).toBe(false);
    a.hud.render(initialState, { status: "disconnected", failures: 1, slow: true });
    expect(hidden()).toBe(false);
    a.hud.render(initialState, connected);
    expect(hidden()).toBe(true);
    const b = setup(false);
    b.hud.render(initialState, { status: "connecting", failures: 3, slow: true });
    expect(b.root.querySelector(".install")!.hasAttribute("hidden")).toBe(true);
  });
  it("shows error messages as text and the attribution line", () => {
    const { root, hud } = setup();
    hud.render(reduce(initialState, { type: "error", code: "invalid_target", message: "<b>bad</b>" }), connected);
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector(".error")!.textContent).toBe("<b>bad</b>");
    expect(root.textContent).toContain("Geo: ip-api.com · ASN: Team Cymru · Map: Natural Earth");
  });
  it("dive/surface toggles call handlers and follow setView", () => {
    const { root, hud, h } = setup();
    const btn = () => root.querySelector<HTMLButtonElement>("button.view")!;
    expect(btn().textContent).toBe("Dive");
    btn().click();
    expect(h.onDive).toHaveBeenCalled();
    hud.setView("tunnel");
    expect(btn().textContent).toBe("Surface");
    btn().click();
    expect(h.onSurface).toHaveBeenCalled();
  });
  it("highlights the focused hop", () => {
    const { root, hud } = setup();
    hud.render(running, connected);
    hud.setFocus(2);
    expect(root.querySelector(".hop.focus")!.getAttribute("data-ttl")).toBe("2");
  });
  it("shows no Cancel and no 'tracing' while running but disconnected", () => {
    const { root, hud } = setup();
    hud.render(running, { status: "disconnected", failures: 1, slow: true });
    const btn = root.querySelector<HTMLButtonElement>("button.trace")!;
    expect(btn.textContent).toBe("Trace");
    expect(btn.disabled).toBe(true);
    expect(root.querySelector(".summary")!.textContent).not.toContain("tracing");
    expect(root.querySelector(".summary")!.textContent).toContain("disconnected");
  });
  it("disables Dive in the globe view with no hops, keeps Surface enabled", () => {
    const { root, hud } = setup();
    const btn = () => root.querySelector<HTMLButtonElement>("button.view")!;
    hud.render(initialState, connected);
    expect(btn().disabled).toBe(true);
    hud.render(running, connected);
    expect(btn().disabled).toBe(false);
    hud.render(initialState, connected);
    hud.setView("tunnel");
    expect(btn().disabled).toBe(false);
  });
});
const quietHop = (ttl: number): Hop => hop(ttl, { ip: null, probes: [{ ip: null, rttMs: null }], city: null, geoSource: "estimated" });
const withHops = (hops: Hop[], target = "example.com", resolvedIp: string | null = "93.184.216.34", done = false) => {
  const s = [
    { type: "trace.started", target, resolvedIp, origin } as const,
    ...hops.map((h) => ({ type: "hop", ...h }) as const),
    ...(done ? [{ type: "trace.done", reached: true } as const] : []),
  ].reduce(reduce, initialState);
  return s;
};
const head = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(`${sel} [role="button"]`)!;

describe("friendly hop list", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("shows the destination once: host plus IP for a hostname, just the IP for an IP", () => {
    const a = setup();
    a.hud.render(withHops([hop(1)]), connected);
    expect(a.root.querySelector(".summary")!.textContent).toBe("To example.com (93.184.216.34) · tracing…");
    const b = setup();
    b.hud.render(withHops([hop(1)], "1.1.1.1", "1.1.1.1"), connected);
    expect(b.root.querySelector(".summary")!.textContent).toBe("To 1.1.1.1 · tracing…");
  });
  it("shows the plain summary line only once the trace is done", () => {
    const { root, hud } = setup();
    const stats = () => root.querySelector<HTMLElement>(".stats")!;
    hud.render(withHops([hop(1, { asn: 701, org: "Verizon" }), hop(2, { asn: 701 })]), connected);
    expect(stats().hidden).toBe(true);
    hud.render(withHops([hop(1, { asn: 701, org: "Verizon" }), hop(2, { asn: 701 })], "example.com", null, true), connected);
    expect(stats().hidden).toBe(false);
    expect(stats().textContent).toBe("2 hops · 1 network · 20 ms");
    expect(root.querySelector(".summary")!.textContent).toBe("To example.com · reached");
  });
  it("collapses silent hops into one quiet row between the responding rows", () => {
    const { root, hud } = setup();
    hud.render(withHops([hop(1), quietHop(2), quietHop(3), hop(4)]), connected);
    const rows = [...root.querySelectorAll<HTMLElement>(".hop")];
    expect(rows.map((r) => r.classList.contains("quiet"))).toEqual([false, true, false]);
    expect(rows[1]!.textContent).toContain("2 routers stayed quiet");
  });
  it("keeps expanded rows open across re-renders, including a growing quiet run", () => {
    const { root, hud } = setup();
    hud.render(withHops([hop(1), quietHop(2)]), connected);
    head(root, '[data-ttl="1"]').click();
    head(root, ".quiet").click();
    hud.render(withHops([hop(1), quietHop(2), quietHop(3)]), connected);
    expect(head(root, '[data-ttl="1"]').getAttribute("aria-expanded")).toBe("true");
    expect(head(root, ".quiet").getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(".quiet")!.textContent).toContain("2 routers stayed quiet");
  });
  it("drops the expansion of rows that disappear (a new trace starts collapsed)", () => {
    const { root, hud } = setup();
    hud.render(withHops([hop(1), hop(2)]), connected);
    head(root, '[data-ttl="2"]').click();
    hud.render(withHops([hop(1)]), connected);
    hud.render(withHops([hop(1), hop(2)]), connected);
    expect(head(root, '[data-ttl="2"]').getAttribute("aria-expanded")).toBe("false");
  });
  it("clicking a hop focuses it in the scene and toggles details; a quiet row only toggles", () => {
    const { root, hud, h } = setup();
    hud.render(withHops([hop(1), quietHop(2)]), connected);
    head(root, '[data-ttl="1"]').click();
    expect(h.onFocusHop).toHaveBeenCalledWith(1);
    expect(root.querySelector('[data-ttl="1"]')!.classList.contains("focus")).toBe(true);
    head(root, ".quiet").click();
    expect(h.onFocusHop).toHaveBeenCalledTimes(1);
  });
  it("highlights the quiet row whose run contains the focused ttl", () => {
    const { root, hud } = setup();
    hud.render(withHops([hop(1), quietHop(2), quietHop(3), hop(4)]), connected);
    hud.setFocus(3);
    expect(root.querySelector(".quiet")!.classList.contains("focus")).toBe(true);
    expect(root.querySelector('[data-ttl="1"]')!.classList.contains("focus")).toBe(false);
    hud.setFocus(null);
    expect(root.querySelector(".focus")).toBeNull();
  });
  it("keeps keyboard focus on the toggled row when the list re-renders", () => {
    const { root, hud } = setup();
    hud.render(withHops([hop(1), hop(2)]), connected);
    head(root, '[data-ttl="2"]').focus();
    hud.render(withHops([hop(1), hop(2), hop(3)]), connected);
    expect(document.activeElement).toBe(head(root, '[data-ttl="2"]'));
  });
});

describe("hud details", () => {
  it("restores keyboard focus without scrolling the list", () => {
    const { root, hud } = setup();
    hud.render(withHops([hop(1), hop(2)]), connected);
    head(root, '[data-ttl="2"]').focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    hud.render(withHops([hop(1), hop(2), hop(3)]), connected);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });
  it("gives the trailing quiet run of an unreached finished trace the 'stopped' subtitle", () => {
    const { root, hud } = setup();
    const s = [
      { type: "trace.started", target: "example.com", resolvedIp: null, origin } as const,
      { type: "hop", ...hop(1) } as const, { type: "hop", ...quietHop(2) } as const,
      { type: "trace.done", reached: false } as const,
    ].reduce(reduce, initialState);
    hud.render(s, connected);
    expect(root.querySelector(".quiet .subtitle")!.textContent).toBe("The trace stopped here; the destination didn't answer.");
    expect(root.querySelector(".stats")!.textContent).toBe("1 hop");
  });
});

describe("install hint", () => {
  const hint = (ua: string) => {
    const root = document.createElement("div");
    mount(root, { onTrace() {}, onCancel() {}, onFocusHop() {}, onDive() {}, onSurface() {} }, { hosted: true, userAgent: ua });
    return root.querySelector(".install .hint")!.textContent;
  };
  it.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/120.0 Mobile/15E148 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/120.0 Mobile/15E148 Safari/605.1.15",
  ])("gives iOS non-Safari browsers the Safari hint", (ua) => {
    expect(hint(ua)).toContain("Safari blocks");
  });
  it("keeps the LNA hint for desktop Chrome", () => {
    expect(hint("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36")).toContain("local network access");
  });
});

describe("destination row focus", () => {
  it("lights up when a scene node it replaced is selected, or its own entry", () => {
    const { root, hud } = setup();
    const dest: Destination = {
      ip: "9.9.9.9", reachable: true, port: 443, rttMs: 9, host: null, asn: null, org: null, lat: 1, lon: 2, city: "X", geoSource: "api",
    };
    const s = [
      { type: "trace.started", target: "example.com", resolvedIp: null, origin } as const,
      { type: "hop", ...hop(1) } as const, { type: "hop", ...quietHop(2) } as const, { type: "hop", ...quietHop(3) } as const,
      { type: "trace.done", reached: false, reason: "quiet", destination: dest } as const,
    ].reduce(reduce, initialState);
    hud.render(s, connected);
    const row = () => root.querySelector(".hop.destination")!;
    hud.setFocus(3); // a quiet hop the destination row replaced
    expect(row().classList.contains("focus")).toBe(true);
    hud.setFocus(4); // the destination's own scene entry
    expect(row().classList.contains("focus")).toBe(true);
    hud.setFocus(1);
    expect(row().classList.contains("focus")).toBe(false);
  });
});

describe("hud.observeOcclusion", () => {
  const stub = (el: Element, left: number, top: number, right: number, bottom: number): void => {
    el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) });
  };

  it("reports each visible panel's rect now, and again only when one changes (on resize)", () => {
    const { root, hud } = setup();
    const [form, , sheet] = root.querySelectorAll(".panel");
    stub(form!, 16, 16, 396, 110);
    stub(sheet!, 16, 122, 396, 704);
    const seen: unknown[] = [];
    hud.observeOcclusion((rects) => seen.push(rects));
    expect(seen).toEqual([[
      { left: 16, top: 16, right: 396, bottom: 110 },
      { left: 16, top: 122, right: 396, bottom: 704 },
    ]]);
    window.dispatchEvent(new Event("resize")); // nothing moved
    expect(seen).toHaveLength(1);
    stub(sheet!, 16, 122, 396, 500);
    window.dispatchEvent(new Event("resize"));
    expect(seen).toHaveLength(2);
    expect((seen[1] as { bottom: number }[])[1]!.bottom).toBe(500);
  });

  it("leaves out panels that have no size (hidden)", () => {
    const { root, hud } = setup();
    stub(root.querySelector(".controls")!, 16, 16, 396, 110);
    const seen: unknown[][] = [];
    hud.observeOcclusion((rects) => seen.push([...rects]));
    expect(seen[0]).toHaveLength(1); // the install panel and the sheet measure 0×0 in jsdom
  });

  it("stops reporting once unsubscribed", () => {
    const { root, hud } = setup();
    stub(root.querySelector(".controls")!, 16, 16, 396, 110);
    const cb = vi.fn();
    const stop = hud.observeOcclusion(cb);
    stop();
    stub(root.querySelector(".controls")!, 16, 16, 300, 110);
    window.dispatchEvent(new Event("resize"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

