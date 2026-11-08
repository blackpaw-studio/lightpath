// Dev-only entry: feeds sampleTimeline through reduce() into the globe view.
// ?test=1 → window.__lightpath steps frames manually; &bloom=full|half|off pins bloom;
// &reduced=1 forces reduced motion.
import { createLoop, rafScheduler } from "../src/loop";
import { initialState, reduce, type TraceState } from "../src/reducer";
import { createGlobeView } from "../src/scene/globe";
import type { BloomTier } from "../src/scene/frameBudget";
import { loadLandDots } from "../src/scene/landdots";
import { installTestHooks, isTestMode, type TestHooks } from "../src/testhooks";
import { sampleTimeline } from "./sample";

const params = new URLSearchParams(location.search);
const test = isTestMode(location.search);
const bloomParam = params.get("bloom");
const bloomTier: BloomTier | undefined =
  bloomParam === "full" || bloomParam === "half" || bloomParam === "off" ? bloomParam : test ? "full" : undefined;
const reducedMotion = params.get("reduced") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches;

const canvas = document.querySelector<HTMLCanvasElement>("#globe");
if (!canvas) throw new Error("missing #globe canvas");

const view = createGlobeView({
  canvas, landDots: await loadLandDots(), reducedMotion, bloomTier,
  width: innerWidth, height: innerHeight, pixelRatio: Math.min(devicePixelRatio, 2),
});

let state: TraceState = initialState;
let next = 0;
const loop = createLoop({
  update: (dt, now) => {
    while (next < sampleTimeline.length && sampleTimeline[next]![0] <= now) state = reduce(state, sampleTimeline[next++]![1]);
    view.setState(state);
    view.update(dt, now);
  },
  render: () => view.render(),
}, test ? undefined : rafScheduler);

addEventListener("resize", () => view.resize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2)));
if (test) installTestHooks(window as Window & { __lightpath?: TestHooks }, { step: loop.step, trace: view.trace, state: () => state });
else loop.start();
