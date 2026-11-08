// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../reducer";
import { mount } from "./hud";
import type { Hop } from "../protocol";

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
const connected = { status: "connected", failures: 0 } as const;

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
    hud.render(initialState, { status: "disconnected", failures: 1 });
    expect(root.querySelector<HTMLButtonElement>("button.trace")!.disabled).toBe(true);
  });
  it("shows the install panel only on the hosted page after a failure", () => {
    const a = setup(true);
    a.hud.render(initialState, { status: "connecting", failures: 0 });
    expect(a.root.querySelector(".install")!.hasAttribute("hidden")).toBe(true);
    a.hud.render(initialState, { status: "disconnected", failures: 1 });
    expect(a.root.querySelector(".install")!.hasAttribute("hidden")).toBe(false);
    a.hud.render(initialState, connected);
    expect(a.root.querySelector(".install")!.hasAttribute("hidden")).toBe(true);
    const b = setup(false);
    b.hud.render(initialState, { status: "disconnected", failures: 3 });
    expect(b.root.querySelector(".install")!.hasAttribute("hidden")).toBe(true);
  });
  it("install panel has the one-liner, run command and agent link", () => {
    const { root } = setup();
    const t = root.querySelector(".install")!.textContent!;
    expect(t).toContain("curl -fsSL https://lightpath.blackpaw.studio/install.sh | sh");
    expect(t).toContain("lightpath");
    expect(root.querySelector<HTMLAnchorElement>('.install a[href="http://127.0.0.1:47800/"]')).not.toBeNull();
    expect(t).toContain("allow it or open the agent page");
  });
  it("copy button writes the one-liner to the clipboard", async () => {
    const { root } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    root.querySelector<HTMLButtonElement>(".install button.copy")!.click();
    expect(writeText).toHaveBeenCalledWith("curl -fsSL https://lightpath.blackpaw.studio/install.sh | sh");
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
});
