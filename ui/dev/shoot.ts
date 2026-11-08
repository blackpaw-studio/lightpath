// Dev-only: drive dev/globe.html in headless Chromium via ?test=1 and save screenshots.
//   node dev/shoot.ts <baseUrl> <outDir> [width height] [query] [shots]
import { chromium } from "@playwright/test";
import { checkTrace, type Frame } from "../src/invariants.ts";

//   shots: "name:ms,name:ms" (virtual ms, ascending), default "mid:3600,done:9000"
const [base = "http://127.0.0.1:5199", out = "dev/screenshots", w = "1280", h = "720", query = "", spec = "mid:3600,done:9000"] =
  process.argv.slice(2);
const shots = spec.split(",").map((s): [string, number] => {
  const [name = "shot", ms = "0"] = s.split(":");
  return [name, Number(ms)];
});

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
page.on("console", (m) => process.stdout.write(`[console] ${m.text()}\n`));
page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${e.message}\n`));
await page.goto(`${base}/dev/globe.html?test=1${query}`);
await page.waitForFunction(() => "__lightpath" in window, null, { timeout: 30000 });
let t = 0;
const frames: Frame[] = [];
for (const [name, until] of shots) {
  frames.push(...await page.evaluate(({ from, to }) => {
    const hooks = (window as unknown as { __lightpath: { step(dt: number): void; trace(): unknown } }).__lightpath;
    const out: unknown[] = [];
    for (let x = from; x < to; x += 1000 / 60) {
      hooks.step(1000 / 60);
      out.push(hooks.trace());
    }
    return out;
  }, { from: t, to: until }) as Frame[]);
  t = until;
  const file = `${out}/${name}-${w}x${h}${query.replace(/[^a-z0-9]+/gi, "-")}.png`;
  await page.screenshot({ path: file });
  process.stdout.write(`${file}\n`);
}
const renderer = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "?";
});
process.stdout.write(`renderer: ${renderer}\n`);
const violations = checkTrace(frames, { maxJumpPx: 48, flickerWindowMs: 1000 });
process.stdout.write(`checkTrace: ${frames.length} frames, ${violations.length} violations\n`);
violations.slice(0, 10).forEach((v) => process.stdout.write(`  ${v.kind} ${v.id} @${v.frame}: ${v.detail}\n`));
await browser.close();
