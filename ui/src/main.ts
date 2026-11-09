// Composition root: conn → controller (reducer) → HUD now, scene once three.js
// has loaded. ?test=1 drives frames through window.__lightpath instead of rAF;
// &bloom=full|half|off pins bloom (test mode defaults to full).
import { createController } from "./app";
import { connect, isAgentServed, wsUrl } from "./conn";
import { mount } from "./hud/hud";
import type { ClientMsg } from "./protocol";
import { createLoop, rafScheduler } from "./loop";
import type { BloomTier } from "./scene/frameBudget";
import { installTestHooks, isTestMode, type TestHooks } from "./testhooks";

const need = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const params = new URLSearchParams(location.search);
const test = isTestMode(location.search);
const bloomParam = params.get("bloom");
const bloomTier: BloomTier | undefined =
  bloomParam === "full" || bloomParam === "half" || bloomParam === "off" ? bloomParam : test ? "full" : undefined;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let send: (msg: ClientMsg) => boolean = () => false;
const ctl = createController({ send: (msg) => send(msg) });
const hud = mount(need<HTMLElement>("#hud-root"), ctl.handlers, { hosted: !isAgentServed(location) });
ctl.attachHud(hud);
const conn = connect({ url: wsUrl(location), onMessage: ctl.onMessage, onState: ctl.onConnState });
send = conn.send;

const startScene = async (): Promise<void> => {
  const [{ createSceneView }, { loadLandDots }] = await Promise.all([
    import("./scene/sceneView"), import("./scene/landdots"),
  ]);
  const dpr = (): number => Math.min(devicePixelRatio, 2);
  const view = createSceneView({
    canvas: need<HTMLCanvasElement>("#scene"), labelLayer: need<HTMLElement>("#labels"),
    fadeLayer: need<HTMLCanvasElement>("#fade"), landDots: await loadLandDots(), reducedMotion, bloomTier,
    width: innerWidth, height: innerHeight, pixelRatio: dpr(),
  });
  ctl.attachScene(view);
  hud.observeOcclusion(view.setOcclusion); // the globe is framed in what the panels leave free
  const loop = createLoop({
    update: (dt, now) => {
      ctl.frame();
      view.update(dt, now);
    },
    render: () => view.render(),
  }, test ? undefined : rafScheduler);
  addEventListener("resize", () => view.resize(innerWidth, innerHeight, dpr()));
  if (!test) return loop.start();
  installTestHooks(window as Window & { __lightpath?: TestHooks }, {
    step: loop.step, trace: view.trace, state: ctl.state,
    // The controller re-syncs the HUD toggle on the next frame.
    dive: view.dive, surface: view.surface,
    focusHop: view.focusHop, mode: view.mode, viewT: view.viewT,
    cameraPosition: () => view.globe.rig.camera.position.toArray() as [number, number, number],
  });
};

startScene().catch((err: unknown) => {
  // The HUD still works without WebGL; the hop list carries every field.
  document.body.classList.add("no-scene");
  console.error("lightpath: scene failed to start", err);
});
