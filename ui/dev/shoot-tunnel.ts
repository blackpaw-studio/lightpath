// Dev-only: drive dev/tunnel.html in headless Chromium via ?test=1 through
// dive → focus → surface, capture screenshots, and run checkTrace (screen,
// world and flicker) over every frame of the transition.
//   node dev/shoot-tunnel.ts <baseUrl> <outDir> [width height] [query] [traceOut]
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [base = "http://127.0.0.1:5199", out = "dev/screenshots", w = "1280", h = "720", query = "", traceOut = ""] =
  process.argv.slice(2);
const FRAME = 1000 / 60;
const tag = `${w}x${h}${query.replace(/[^a-z0-9]+/gi, "-")}`;

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
page.on("console", (m) => process.stdout.write(`[console] ${m.text()}\n`));
page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${e.message}\n`));
await page.goto(`${base}/dev/tunnel.html?test=1${query}`);
await page.waitForFunction(() => "__lightpath" in window, null, { timeout: 30000 });

type Hooks = Record<string, (arg?: number) => unknown>;

/** Step `ms` of virtual time at 60 fps, returning each frame's trace when recording. */
const step = (ms: number, record: boolean): Promise<unknown[]> =>
  page.evaluate(({ ms, dt, record }) => {
    const hooks = (window as unknown as { __lightpath: Hooks }).__lightpath;
    const frames: unknown[] = [];
    for (let t = 0; t < ms - 1e-6; t += dt) {
      hooks.step!(dt);
      if (record) frames.push(hooks.trace!());
    }
    return frames;
  }, { ms, dt: FRAME, record });

const call = <T>(fn: string, arg?: number): Promise<T> =>
  page.evaluate(({ fn, arg }) => {
    const hooks = (window as unknown as { __lightpath: Hooks }).__lightpath;
    return hooks[fn]!(arg) as T;
  }, { fn, arg });

const shot = async (name: string): Promise<void> => {
  const file = `${out}/tunnel-${name}-${tag}.png`;
  await page.screenshot({ path: file });
  const mode = await call<string>("mode");
  const viewT = await call<number>("viewT");
  process.stdout.write(`${file}  mode=${mode} viewT=${viewT.toFixed(3)}\n`);
};

await step(9000, false);
const frames: unknown[] = [];
const rec = async (ms: number): Promise<void> => {
  frames.push(...await step(ms, true));
};
await rec(FRAME);
const globeAt = 0;
if (!await call<boolean>("dive")) throw new Error("dive() refused");
await rec(1150);
await shot("dive-mid");
await rec(700);
await shot("dive-portal");
await rec(1100);
await shot("inside");
const tunnelAt = frames.length - 1;
await call<boolean>("focusHop", 7);
await rec(2600);
await shot("focus7");
// Dwell: Surface reverses back through the gates the focus glide passed, so
// give them over a second behind the camera (a quicker reversal reads as flicker).
await rec(1500);
await call("surface");
await rec(1500);
await shot("surface-mid");
await rec(3500);
await shot("surfaced");

const result = await page.evaluate(async ({ frames, globeAt, tunnelAt, reduced }) => {
  // Vite serves these to the page; the paths are page URLs, not node modules.
  const inv = (await import("/src/invariants.ts" as string)) as typeof import("../src/invariants");
  const mb = (await import("/src/scene/motionBudget.ts" as string)) as typeof import("../src/scene/motionBudget");
  const fs = frames as Parameters<typeof inv.checkTrace>[0];
  // Reduced motion runs the same flights within the REDUCED_MS crossfade.
  const tr = (await import("/src/scene/transition.ts" as string)) as typeof import("../src/scene/transition");
  const runMs = reduced ? tr.REDUCED_MS : tr.DIVE_MS;
  const maxJumpWorld = mb.worldJumpBound(fs[globeAt]!, fs[tunnelAt]!, 1000 / 60, runMs);
  const opts = { maxJumpPx: mb.MAX_JUMP_PX, flickerWindowMs: mb.FLICKER_WINDOW_MS, maxJumpWorld };
  return { opts, violations: inv.checkTrace(fs, opts) };
}, { frames, globeAt, tunnelAt, reduced: /reduced=1/.test(query) });
if (traceOut) writeFileSync(traceOut, JSON.stringify(frames));
const ids = new Set(frames.flatMap((f) => Object.keys((f as { entities: object }).entities)));
const count = (prefix: string): number => [...ids].filter((id) => id.startsWith(prefix)).length;
process.stdout.write(`entities: ${ids.size} (${count("g:")} g:, ${count("l:")} l:)\n`);
process.stdout.write(
  `checkTrace: ${frames.length} frames, maxJumpPx=${result.opts.maxJumpPx}, ` +
  `maxJumpWorld=${result.opts.maxJumpWorld.toFixed(3)}, ${result.violations.length} violations\n`,
);
result.violations.slice(0, 12).forEach((v) => process.stdout.write(`  ${v.kind} ${v.id} @${v.frame}: ${v.detail}\n`));
await browser.close();
