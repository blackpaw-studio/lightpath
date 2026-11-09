import { describe, expect, it, vi } from "vitest";
import { CANCELLED_MESSAGE, DISCONNECTED_MESSAGE, createController, hudView, type HudLike, type SceneLike } from "./app";
import type { ConnState } from "./conn";
import type { ClientMsg, ServerMsg } from "./protocol";
import type { ShownState } from "./plausibility";
import type { TraceState } from "./reducer";
import type { View } from "./hud/hud";
import type { ViewMode } from "./scene/transition";

const started: ServerMsg = {
  type: "trace.started", target: "example.com", resolvedIp: "9.9.9.9",
  origin: { publicIp: "1.1.1.1", lat: 1, lon: 2, city: "X", asn: null, org: null },
};
const hop = (ttl: number): ServerMsg => ({
  type: "hop", ttl, probes: [{ ip: "10.0.0.1", rttMs: 1 }], ip: "10.0.0.1", host: null, asn: null, org: null,
  lat: null, lon: null, city: null, geoSource: "estimated", annotations: [],
});
const connected: ConnState = { status: "connected", failures: 0, slow: false };
const disconnected: ConnState = { status: "disconnected", failures: 1, slow: true };

const fakeHud = () => {
  const calls = { renders: [] as [ShownState, ConnState][], views: [] as View[], focus: [] as (number | null)[] };
  const hud: HudLike = {
    render: (s, c) => calls.renders.push([s, c]),
    setView: (v) => calls.views.push(v),
    setFocus: (t) => calls.focus.push(t),
  };
  return { hud, calls, last: () => calls.renders[calls.renders.length - 1]! };
};

const fakeScene = (initial: ViewMode = "globe") => {
  let mode: ViewMode = initial;
  const seen: ShownState[] = [];
  const scene: SceneLike = {
    setState: (s) => seen.push(s),
    dive: () => { mode = "diving"; return true; },
    surface: () => { mode = "surfacing"; },
    focusHop: () => true,
    mode: () => mode,
  };
  return { scene, seen, setMode: (m: ViewMode) => { mode = m; } };
};

const setup = (sendOk = true) => {
  const sent: ClientMsg[] = [];
  const ctl = createController({ send: (m) => { sent.push(m); return sendOk; } });
  const h = fakeHud();
  ctl.attachHud(h.hud);
  return { ctl, sent, ...h };
};

describe("hudView", () => {
  it("offers Surface while diving or in the tunnel, Dive on the globe or while surfacing", () => {
    expect([hudView("globe"), hudView("diving"), hudView("tunnel"), hudView("surfacing")])
      .toEqual(["globe", "tunnel", "tunnel", "globe"]);
  });
});

describe("createController", () => {
  it("interrupts a running trace when the agent connection drops", () => {
    const { ctl, last } = setup();
    const s = fakeScene();
    ctl.attachScene(s.scene);
    ctl.onConnState(connected);
    [started, hop(1)].forEach(ctl.onMessage);
    ctl.onConnState(disconnected);
    ctl.frame();
    expect(ctl.state()).toMatchObject({ status: "error", error: { code: "disconnected", message: DISCONNECTED_MESSAGE } });
    expect(ctl.state().hops).toHaveLength(1);
    expect(s.seen[s.seen.length - 1]!.status).toBe("error");
    expect(last()[0]).toMatchObject(ctl.state());
    expect(last()[1]).toEqual(disconnected);
  });

  it("does not touch a finished trace or a connection that never opened", () => {
    const { ctl } = setup();
    ctl.onConnState(connected);
    [started, { type: "trace.done", reached: true } as ServerMsg].forEach(ctl.onMessage);
    ctl.onConnState(disconnected);
    expect(ctl.state().status).toBe("done");
    const fresh = setup();
    fresh.ctl.onConnState(disconnected);
    expect(fresh.ctl.state().status).toBe("idle");
  });

  it("cancel sends trace.cancel and ends the running trace locally", () => {
    const { ctl, sent } = setup();
    ctl.onMessage(started);
    ctl.handlers.onCancel();
    expect(sent).toEqual([{ type: "trace.cancel" }]);
    expect(ctl.state()).toMatchObject({ status: "error", error: { code: "cancelled", message: CANCELLED_MESSAGE } });
  });

  it("keeps the trace running when the cancel could not be sent", () => {
    const { ctl } = setup(false);
    ctl.onMessage(started);
    ctl.handlers.onCancel();
    expect(ctl.state().status).toBe("running");
  });

  it("trace submits trace.start with the target", () => {
    const { ctl, sent } = setup();
    ctl.handlers.onTrace("1.1.1.1");
    expect(sent).toEqual([{ type: "trace.start", target: "1.1.1.1" }]);
  });

  it("keeps the HUD toggle on the scene's mode, including moves the HUD did not start", () => {
    const { ctl, calls } = setup();
    const s = fakeScene();
    ctl.attachScene(s.scene);
    ctl.handlers.onDive();
    expect(calls.views).toEqual(["globe", "tunnel"]);
    ctl.frame();
    s.setMode("surfacing"); // e.g. a test hook or keyboard surface
    ctl.frame();
    s.setMode("globe");
    ctl.frame();
    expect(calls.views).toEqual(["globe", "tunnel", "globe"]);
  });

  it("hands the HUD and the scene the same derived state, with an impossible location dropped", () => {
    const { ctl, last } = setup();
    const s = fakeScene();
    ctl.attachScene(s.scene);
    const far: ServerMsg = { ...(hop(1) as Extract<ServerMsg, { type: "hop" }>), lat: -27.47, lon: 153.03, city: "Brisbane", geoSource: "api" };
    [started, far].forEach(ctl.onMessage);
    ctl.frame();
    const shown = s.seen[s.seen.length - 1]!;
    expect(last()[0]).toBe(shown);
    expect(shown.hops[0]).toMatchObject({ geoSource: "estimated", lat: null, city: null });
    expect(shown.doubts.get(1)).toEqual({ place: "Brisbane", rttMs: 1 });
    expect(ctl.state().hops[0]).toMatchObject({ geoSource: "api", city: "Brisbane" }); // the raw state stays as sent
  });

  it("derives once per state, not once per frame", () => {
    const derive = vi.fn((s: TraceState): ShownState => ({ ...s, doubts: new Map(), destinationDoubt: null }));
    const ctl = createController({ send: () => true, derive });
    const h = fakeHud();
    const s = fakeScene();
    ctl.attachHud(h.hud);
    ctl.attachScene(s.scene);
    ctl.onMessage(started);
    ctl.frame();
    ctl.frame();
    expect(derive.mock.calls.filter(([st]) => st === ctl.state())).toHaveLength(1);
    expect(s.seen[s.seen.length - 1]).toBe(s.seen[s.seen.length - 2]);
  });

  it("clears the hop focus when a new trace starts", () => {
    const { ctl, calls } = setup();
    ctl.onMessage(started);
    ctl.onMessage(hop(1));
    ctl.onMessage(started);
    expect(calls.focus).toEqual([null, null]);
  });
});
