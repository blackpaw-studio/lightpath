// Shared E2E helpers: open the agent-served page in test mode, drive frames
// through window.__lightpath, record per-frame traces and check them.
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { checkTrace, type Frame, type TraceOptions, type Violation } from "../src/invariants";
import type { TraceState } from "../src/reducer";
import { APPEAR_MS, GLIDE_MAX_RAD_PER_S, ORIGIN_KEY } from "../src/scene/globePoses";
import { FLICKER_WINDOW_MS, MAX_JUMP_PX } from "../src/scene/motionBudget";
import type { Rect } from "../src/scene/safeArea";
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

/** A recorded frame plus the trace generation it belongs to and the HUD panels' rects at that frame. */
export interface GenFrame extends TraceFrame {
  readonly gen: number;
  readonly panels: readonly Rect[];
}

type HookWindow = Window & { __lightpath: Required<TestHooks> };

export const openApp = async (page: Page, agent: Agent): Promise<void> => {
  await page.goto(agentUrl(agent));
  // Fail fast and legibly when the scene never starts (e.g. no WebGL in headless Firefox on Linux).
  await page.waitForFunction(
    () => "__lightpath" in window || document.body.classList.contains("no-scene"),
    null,
    { timeout: 30_000 },
  );
  const noScene = await page.evaluate(() => document.body.classList.contains("no-scene"));
  if (noScene) throw new Error("scene failed to start (no-scene): is WebGL available in this browser?");
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
    const panels = (): Rect[] => [...document.querySelectorAll(".hud .panel")].map((p) => p.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    const n = Math.round(ms / dt);
    for (let i = 0; i < n; i++) {
      hooks.step(dt, i === n - 1);
      if (record) frames.push({ ...hooks.trace(), gen: hooks.state().generation, panels: panels() });
    }
    return frames;
  }, { ms, dt: FRAME_MS, record });

/**
 * Steps one frame per real 16.7 ms while the replay streams hops in, recording
 * every frame, until the trace is done and `tailMs` more has passed, so virtual
 * time tracks the replay's real timing. Frames are not drawn (see step).
 * Pacing yields through MessageChannel: headless Chromium on macOS stretches
 * setTimeout(16) to ~110 ms, which would let virtual time fall behind.
 */
export const stepLive = (page: Page, tailMs: number, maxMs = 30_000): Promise<GenFrame[]> =>
  page.evaluate(async ({ dt, tailMs, maxMs }) => {
    const hooks = (window as unknown as HookWindow).__lightpath;
    const frames: GenFrame[] = [];
    const panels = (): Rect[] => [...document.querySelectorAll(".hud .panel")].map((p) => p.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    const channel = new MessageChannel();
    const yieldTask = (): Promise<unknown> => new Promise((r) => {
      channel.port1.onmessage = r;
      channel.port2.postMessage(0);
    });
    let doneAt: number | null = null;
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      hooks.step(dt, false);
      const s = hooks.state();
      frames.push({ ...hooks.trace(), gen: s.generation, panels: panels() });
      if (s.status === "done" && doneAt === null) doneAt = performance.now();
      if (doneAt !== null && performance.now() - doneAt >= tailMs) break;
      const due = t0 + frames.length * dt;
      do await yieldTask(); while (performance.now() < due);
    }
    hooks.step(0, true);
    return frames;
  }, { dt: FRAME_MS, tailMs, maxMs });

/** Hop ttl of a trace entity id: "5" (pose), "g:5" (drawn marker) or "l:5" (label). */
export const ttlOf = (id: string): number => Number(id.replace(/^[gla]:/, ""));

/** Pose entities only (the bare-ttl ids), without the g:/l: drawn marks. */
export const poseIds = (f: Frame): string[] => Object.keys(f.entities).filter((k) => /^\d+$/.test(k)).sort();

/**
 * Hop entities are keyed by ttl, which a new trace reuses: key them by
 * generation too so a restarted trace's hop 1 is a new entity, not a teleport
 * of the old one. The origin (pose, marker and label) keeps its key: it is the
 * same machine across traces.
 */
export const byGeneration = (frames: readonly GenFrame[]): Frame[] =>
  frames.map((f) => ({
    tMs: f.tMs,
    cut: f.cut,
    entities: Object.fromEntries(Object.entries(f.entities).map(([k, e]) => [ttlOf(k) === ORIGIN_KEY ? k : `${f.gen}:${k}`, e])),
  }));

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * World bound while hops stream in on the globe: every relocation glides at no
 * more than GLIDE_MAX_RAD_PER_S, so no node moves further than that in one
 * frame (10 % margin covers idle rotation). A snap of any visible size exceeds it.
 */
export const STREAM_MAX_JUMP_WORLD = (GLIDE_MAX_RAD_PER_S * FRAME_MS) / 1000 * 1.1;

/** Largest extent of any one entity's path (proves a recording actually contains a move). */
export const pathExtent = (frames: readonly Frame[], id: string): number => {
  const ws = frames.flatMap((f) => (f.entities[id]?.world ? [f.entities[id]!.world!] : []));
  return ws.reduce((m, w) => Math.max(m, dist(w, ws[0]!)), 0);
};

export const traceOptions = (maxJumpWorld?: number): TraceOptions =>
  ({ maxJumpPx: MAX_JUMP_PX, flickerWindowMs: FLICKER_WINDOW_MS, maxJumpWorld });

/**
 * An arc's crest moves with its endpoints: at most a glide's worth of arc radius
 * (1 + 0.25·π at the very most) per frame. A jump in arc shape is far larger than that.
 */
export const ARC_MAX_JUMP_WORLD = STREAM_MAX_JUMP_WORLD * 1.8;

/** The arc-shape check: world continuity of each arc's crest (the a:<ttl> entities). */
export const expectArcsSmooth = (frames: readonly Frame[]): void => {
  const arcs = frames.map((f) => ({ ...f, entities: Object.fromEntries(Object.entries(f.entities).filter(([k]) => isArcId(k))) }));
  expect(arcs.some((f) => Object.keys(f.entities).length > 0), "the trace records arc entities").toBe(true);
  assertNoViolations(arcs, { maxJumpPx: Infinity, flickerWindowMs: 0, maxJumpWorld: ARC_MAX_JUMP_WORLD });
};

const isArcId = (id: string): boolean => /(^|:)a:\d+$/.test(id);

/** Asserts checkTrace finds no violations on the nodes, gates and labels (arc shapes have their own bound). */
export const expectSmooth = (frames: readonly Frame[], opts: TraceOptions): void =>
  assertNoViolations(frames.map((f) => ({ ...f, entities: Object.fromEntries(Object.entries(f.entities).filter(([k]) => !isArcId(k))) })), opts);

/** Asserts checkTrace finds no violations, printing the first few and saving the frames on failure. */
const assertNoViolations = (frames: readonly Frame[], opts: TraceOptions): void => {
  const violations: Violation[] = checkTrace(frames, opts);
  if (violations.length > 0) {
    // Kept beside the failure for offline inspection.
    writeFileSync(test.info().outputPath("frames.json"), JSON.stringify(frames));
  }
  const report = violations.slice(0, 12).map((v) => `${v.kind} ${v.id} @${v.frame}: ${v.detail}`).join("\n");
  expect(violations, `${violations.length} motion violations over ${frames.length} frames\n${report}`).toEqual([]);
};

/**
 * No drawn node (pose entities, the origin included) sits behind a HUD panel. A node
 * gets one APPEAR_MS after it first shows for the camera's zoom-out to catch up with it.
 */
export const expectClearOfPanels = (frames: readonly GenFrame[], graceMs = APPEAR_MS): void => {
  const firstSeen = new Map<string, number>();
  const hidden: string[] = [];
  for (const f of frames) {
    for (const [id, e] of Object.entries(f.entities)) {
      if (!/^\d+$/.test(id) || !e.visible) continue;
      const key = f.gen + ":" + id;
      if (!firstSeen.has(key)) firstSeen.set(key, f.tMs);
      if (f.tMs - firstSeen.get(key)! < graceMs) continue;
      if (f.panels.some((p) => e.x > p.left && e.x < p.right && e.y > p.top && e.y < p.bottom)) {
        hidden.push(key + " at (" + e.x.toFixed(0) + ", " + e.y.toFixed(0) + ") @" + f.tMs.toFixed(0) + "ms");
      }
    }
  }
  expect(hidden.slice(0, 12), hidden.length + " node-frames behind a panel").toEqual([]);
};

/**
 * After a trace: every pose entity faces the camera (its world point is on the visible
 * hemisphere) and is drawn inside the viewport and clear of the panels.
 */
export const expectFacingAndSafe = async (page: Page, frame: GenFrame): Promise<void> => {
  const cam = await page.evaluate(() => (window as unknown as HookWindow).__lightpath.cameraPosition());
  const view = page.viewportSize()!;
  for (const id of poseIds(frame)) {
    const e = frame.entities[id]!;
    const facing = e.world[0] * cam[0] + e.world[1] * cam[1] + e.world[2] * cam[2];
    expect(facing, "node " + id + " faces the camera").toBeGreaterThan(1);
    expect(e.x, "node " + id + " x in view").toBeGreaterThan(0);
    expect(e.x, "node " + id + " x in view").toBeLessThan(view.width);
    expect(e.y, "node " + id + " y in view").toBeGreaterThan(0);
    expect(e.y, "node " + id + " y in view").toBeLessThan(view.height);
    const hit = frame.panels.find((p) => e.x > p.left && e.x < p.right && e.y > p.top && e.y < p.bottom);
    expect(hit, "node " + id + " at (" + e.x.toFixed(0) + ", " + e.y.toFixed(0) + ") behind a panel").toBeUndefined();
  }
};

/** Pixel comparison against the local darwin baseline; a recorded no-op elsewhere. */
export const expectShot = async (page: Page, name: string): Promise<void> => {
  if (!screenshotsEnabled) {
    test.info().annotations.push({ type: "screenshot-skipped", description: `${name}: remote/CI run, no darwin baseline` });
    return;
  }
  await expect(page).toHaveScreenshot(name, { animations: "disabled", caret: "hide" });
};
