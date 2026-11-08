// Dev-only entry: sample trace → globe + tunnel scene with Dive/Surface controls.
// ?test=1 → window.__lightpath steps frames manually (controls hidden unless &ui=1);
// &bloom=full|half|off pins bloom; &reduced=1 forces reduced motion.
import { createLoop, rafScheduler } from "../src/loop";
import { initialState, reduce, type TraceState } from "../src/reducer";
import type { BloomTier } from "../src/scene/frameBudget";
import { loadLandDots } from "../src/scene/landdots";
import { createSceneView } from "../src/scene/sceneView";
import { installTestHooks, isTestMode, type TestHooks } from "../src/testhooks";
import { sampleTimeline } from "./sample";

const params = new URLSearchParams(location.search);
const test = isTestMode(location.search);
const bloomParam = params.get("bloom");
const bloomTier: BloomTier | undefined =
  bloomParam === "full" || bloomParam === "half" || bloomParam === "off" ? bloomParam : test ? "full" : undefined;
const reducedMotion = params.get("reduced") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches;

const need = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const canvas = need<HTMLCanvasElement>("#scene");
const dpr = (): number => Math.min(devicePixelRatio, 2);

const view = createSceneView({
  canvas, labelLayer: need<HTMLElement>("#labels"), fadeLayer: need<HTMLCanvasElement>("#fade"),
  landDots: await loadLandDots(), reducedMotion, bloomTier, width: innerWidth, height: innerHeight, pixelRatio: dpr(),
});

let state: TraceState = initialState;
let next = 0;
const modeEl = need<HTMLElement>("#mode");
const focus = need<HTMLSelectElement>("#focus");
const loop = createLoop({
  update: (dt, now) => {
    while (next < sampleTimeline.length && sampleTimeline[next]![0] <= now) state = reduce(state, sampleTimeline[next++]![1]);
    view.setState(state);
    view.update(dt, now);
    if (modeEl.textContent !== view.mode()) modeEl.textContent = view.mode();
    if (focus.options.length - 2 < state.hops.length) {
      focus.replaceChildren(new Option("Focus…", ""), new Option("origin", "0"), ...state.hops.map((h) => new Option(`hop ${h.ttl}`, String(h.ttl))));
    }
  },
  render: () => view.render(),
}, test ? undefined : rafScheduler);

need<HTMLButtonElement>("#dive").addEventListener("click", () => view.dive());
need<HTMLButtonElement>("#surface").addEventListener("click", () => view.surface());
focus.addEventListener("change", () => {
  if (focus.value !== "") view.focusHop(Number(focus.value));
  focus.value = "";
});
addEventListener("resize", () => view.resize(innerWidth, innerHeight, dpr()));

if (test) {
  need<HTMLElement>("#controls").hidden = params.get("ui") !== "1";
  installTestHooks(window as Window & { __lightpath?: TestHooks }, {
    step: loop.step, trace: view.trace, state: () => state,
    dive: view.dive, surface: view.surface, focusHop: view.focusHop, mode: view.mode, viewT: view.viewT,
  });
} else loop.start();
