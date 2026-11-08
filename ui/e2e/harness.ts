// Shared E2E helpers: open the agent-served page in test mode, drive frames
// through window.__lightpath, record per-frame traces and check them.
import { expect, test, type Page } from "@playwright/test";
import { checkTrace, type Frame, type TraceOptions, type Violation } from "../src/invariants";
import type { TraceState } from "../src/reducer";
import { GLIDE_TAU_MS, ORIGIN_KEY } from "../src/scene/globePoses";
import { FLICKER_WINDOW_MS, MAX_JUMP_PX } from "../src/scene/motionBudget";
import type { TestHooks, TraceFrame } from "../src/testhooks";
import { agentUrl, type Agent } from "./agents";

export const FRAME_MS = 1000 / 60;

/**
 * Screenshot baselines are darwin-only and were generated locally. Remote runs
 * (Apollo browser server, Linux fonts and GPU) and CI skip the pixel
 * comparison; their functional and motion-trace assertions still run.
 * Regenerating baselines against the remote server needs the repo owner's approval.
 */
export const screenshotsEnabled =
  !process.env.PW_TEST_CONNECT_WS_ENDPOINT && !process.env.CI && process.platform === "darwin";

/** A recorded frame plus the trace generation it belongs to. */
export interface GenFrame extends TraceFrame {
  readonly gen: number;
}

type HookWindow = Window & { __lightpath: Required<TestHooks> };

export const openApp = async (page: Page, agent: Agent): Promise<void> => {
  await page.goto(agentUrl(agent));
  await page.waitForFunction(() => "__lightpath" in window, null, { timeout: 30_000 });
  await expect(page.locator(".chip")).toHaveText("connected");
};

export const startTrace = async (page: Page, target = "example.com"): Promise<void> => {
  await page.getByLabel("Trace target").fill(target);
  await page.getByRole("button", { name: "Trace" }).click();
};

export const state = (page: Page): Promise<TraceState> =>
  page.evaluate(() => (window as unknown as HookWindow).__lightpath.state());

/** Waits for the replay to finish without stepping, so later stepping starts from a fixed virtual time. */
export const waitForDone = (page: Page, timeout = 30_000): Promise<unknown> =>
  page.waitForFunction(() => (window as unknown as HookWindow).__lightpath.state().status === "done", null, { timeout });

export const call = <T>(page: Page, fn: "dive" | "surface" | "focusHop" | "mode" | "viewT", arg?: number): Promise<T> =>
  page.evaluate(({ fn, arg }) => {
    const hooks = (window as unknown as HookWindow).__lightpath;
    return (hooks[fn] as (a?: number) => unknown)(arg) as T;
  }, { fn, arg });

/**
 * Steps `ms` of virtual time at 60 fps in one round trip, returning each frame
 * when recording. Only the last frame is drawn: poses, camera and the traced
 * frame all come from update(), and software GL (headless/remote Chromium)
 * costs ~300 ms per drawn frame. Screenshots see that last frame.
 */
export const step = (page: Page, ms: number, record = false): Promise<GenFrame[]> =>
  page.evaluate(({ ms, dt, record }) => {
    const hooks = (window as unknown as HookWindow).__lightpath;
    const frames: GenFrame[] = [];
    const n = Math.round(ms / dt);
    for (let i = 0; i < n; i++) {
      hooks.step(dt, i === n - 1);
      if (record) frames.push({ ...hooks.trace(), gen: hooks.state().generation });
    }
    return frames;
  }, { ms, dt: FRAME_MS, record });

/**
 * Steps one frame per real ~16 ms while the replay streams hops in, recording
 * every frame, until the trace is done and `tailMs` more has passed. Frames
 * are not drawn (see step) so the pacing stays close to real time.
 */
export const stepLive = (page: Page, tailMs: number, maxMs = 30_000): Promise<GenFrame[]> =>
  page.evaluate(async ({ dt, tailMs, maxMs }) => {
    const hooks = (window as unknown as HookWindow).__lightpath;
    const frames: GenFrame[] = [];
    let doneAt: number | null = null;
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      hooks.step(dt, false);
      const s = hooks.state();
      frames.push({ ...hooks.trace(), gen: s.generation });
      if (s.status === "done" && doneAt === null) doneAt = performance.now();
      if (doneAt !== null && performance.now() - doneAt >= tailMs) break;
      await new Promise((r) => setTimeout(r, dt));
    }
    hooks.step(0, true);
    return frames;
  }, { dt: FRAME_MS, tailMs, maxMs });

/**
 * Hop entities are keyed by ttl, which a new trace reuses: key them by
 * generation too so a restarted trace's hop 1 is a new entity, not a teleport
 * of the old one. The origin keeps its key: it is the same machine across traces.
 */
export const byGeneration = (frames: readonly GenFrame[]): Frame[] =>
  frames.map((f) => ({
    tMs: f.tMs,
    cut: f.cut,
    entities: Object.fromEntries(Object.entries(f.entities).map(([k, e]) => [k === String(ORIGIN_KEY) ? k : `${f.gen}:${k}`, e])),
  }));

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * World continuity while hops stream in on the globe. A relocated node glides
 * (exponential approach, time constant GLIDE_TAU_MS), so one frame covers at
 * most 1 − e^(−dt/τ) of its remaining way (less when its speed cap applies);
 * a snap covers all of it. Each entity's per-frame move is bounded by twice that
 * fraction of the extent of its own path, so a short snap cannot hide behind
 * another hop's long glide. The 2× margin covers estimated hops, whose target
 * itself moves while a neighbour glides.
 */
export const checkGlides = (frames: readonly Frame[]): Violation[] => {
  const paths = new Map<string, { frame: number; w: readonly number[] }[]>();
  frames.forEach((f, i) => Object.entries(f.entities).forEach(([k, e]) => {
    if (e.world) paths.set(k, [...(paths.get(k) ?? []), { frame: i, w: e.world }]);
  }));
  const fraction = (1 - Math.exp(-FRAME_MS / GLIDE_TAU_MS)) * 2;
  return [...paths].flatMap(([id, path]) => {
    const extent = path.reduce((m, a) => path.reduce((mm, b) => Math.max(mm, dist(a.w, b.w)), m), 0);
    const limit = extent * fraction + 1e-6;
    return path.slice(1).flatMap((p, j) => {
      const d = dist(p.w, path[j]!.w);
      return d > limit ? [{ kind: "worldJump" as const, id, frame: p.frame, detail: `${d.toFixed(4)} > ${limit.toFixed(4)} (path extent ${extent.toFixed(3)})` }] : [];
    });
  });
};

/** Largest extent of any one entity's path (proves a recording actually contains a move). */
export const pathExtent = (frames: readonly Frame[], id: string): number => {
  const ws = frames.flatMap((f) => (f.entities[id]?.world ? [f.entities[id]!.world!] : []));
  return ws.reduce((m, w) => Math.max(m, dist(w, ws[0]!)), 0);
};

export const traceOptions = (maxJumpWorld?: number): TraceOptions =>
  ({ maxJumpPx: MAX_JUMP_PX, flickerWindowMs: FLICKER_WINDOW_MS, maxJumpWorld });

/** Asserts no violations (checkTrace plus any extra checks), printing the first few. */
export const expectSmooth = (frames: readonly Frame[], opts: TraceOptions, extra: readonly Violation[] = []): void => {
  const violations: Violation[] = [...checkTrace(frames, opts), ...extra];
  const report = violations.slice(0, 12).map((v) => `${v.kind} ${v.id} @${v.frame}: ${v.detail}`).join("\n");
  expect(violations, `${violations.length} motion violations over ${frames.length} frames\n${report}`).toEqual([]);
};

/** Pixel comparison against the local darwin baseline; a recorded no-op elsewhere. */
export const expectShot = async (page: Page, name: string): Promise<void> => {
  if (!screenshotsEnabled) {
    test.info().annotations.push({ type: "screenshot-skipped", description: `${name}: remote/CI run, no darwin baseline` });
    return;
  }
  await expect(page).toHaveScreenshot(name, { animations: "disabled", caret: "hide" });
};
