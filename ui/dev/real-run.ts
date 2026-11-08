// Dev-only S3.3 real-run check (not CI). Drives the agent-served page in local
// Chromium through real traces and measures, per hop, the delay between the
// traceroute line completing and the page receiving its `hop` event.
//
//   LP_TRACE_LOG=<log> PATH=<dir with the timestamping traceroute shim>:$PATH \
//     ../lightpath --no-open --port 47820 &
//   node dev/real-run.ts http://127.0.0.1:47820 <log> dev/screenshots example.com 1.1.1.1
//
// The shim logs "epoch_ms<TAB>line" as each line arrives on the pipe the agent
// would read, so the delay covers parsing, enrichment hand-off and the socket.
import { readFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const [base = "http://127.0.0.1:47820", logPath = "", outDir = "dev/screenshots", ...targets] = process.argv.slice(2);
if (!logPath || targets.length === 0) throw new Error("usage: real-run.ts <baseUrl> <traceLog> <outDir> <target>...");
const FRAME = 1000 / 60;

type Hooks = { step(dt: number, render?: boolean): void; state(): { status: string; hops: { ttl: number }[] }; dive(): boolean; mode(): string };

interface Received { readonly ttl: number; readonly atMs: number }

/** Line-completion times per TTL for the trace whose argv ends with `target`. */
const lineTimes = (target: string): Map<number, number> => {
  const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => {
    const tab = l.indexOf("\t");
    return { at: Number(l.slice(0, tab)), text: l.slice(tab + 1) };
  });
  const start = rows.map((r) => r.text.startsWith("# argv") && r.text.trim().endsWith(` ${target}`)).lastIndexOf(true);
  if (start < 0) throw new Error(`no traceroute run for ${target} in ${logPath}`);
  const out = new Map<number, number>();
  for (const r of rows.slice(start + 1)) {
    if (r.text.startsWith("# argv")) break;
    const m = /^\s*(\d+)\s/.exec(r.text);
    if (m) out.set(Number(m[1]), r.at);
  }
  return out;
};

const step = (page: Page, ms: number): Promise<void> =>
  page.evaluate(({ ms, dt }) => {
    const h = (window as unknown as { __lightpath: Hooks }).__lightpath;
    const n = Math.round(ms / dt);
    for (let i = 0; i < n; i++) h.step(dt, i === n - 1);
  }, { ms, dt: FRAME });

const trace = async (page: Page, target: string): Promise<Received[]> => {
  const received: Received[] = [];
  const onFrame = (payload: string | Buffer): void => {
    const msg = JSON.parse(String(payload)) as { type: string; ttl?: number };
    if (msg.type === "hop" && msg.ttl !== undefined) received.push({ ttl: msg.ttl, atMs: Date.now() });
  };
  page.on("websocket", (ws) => ws.on("framereceived", (f) => onFrame(f.payload)));
  await page.goto(`${base}/?test=1`);
  await page.waitForSelector(".chip.connected");
  await page.getByLabel("Trace target").fill(target);
  await page.getByRole("button", { name: "Trace" }).click();
  await page.waitForFunction(() => {
    const s = (window as unknown as { __lightpath: Hooks }).__lightpath.state().status;
    return s === "done" || s === "error";
  }, null, { timeout: 120_000, polling: 250 });
  return received;
};

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
let worst = 0;
for (const [i, target] of targets.entries()) {
  const received = await trace(page, target);
  const lines = lineTimes(target);
  const delays = received.flatMap((r) => (lines.has(r.ttl) ? [{ ttl: r.ttl, ms: r.atMs - lines.get(r.ttl)! }] : []));
  const state = await page.evaluate(() => (window as unknown as { __lightpath: Hooks }).__lightpath.state());
  const rows = await page.locator(".hop").count();
  worst = Math.max(worst, ...delays.map((d) => d.ms));
  process.stdout.write(
    `${target}: status=${state.status} hops=${state.hops.length} rows=${rows} lines=${lines.size} ` +
    `delays(ms)=${delays.map((d) => `${d.ttl}:${d.ms}`).join(" ")} max=${Math.max(...delays.map((d) => d.ms))}\n`,
  );
  if (i === targets.length - 1) {
    await step(page, 6000);
    await page.screenshot({ path: `${outDir}/real-globe.png` });
    await page.evaluate(() => (window as unknown as { __lightpath: Hooks }).__lightpath.dive());
    await step(page, 3500);
    await page.screenshot({ path: `${outDir}/real-tunnel.png` });
  }
}
process.stdout.write(`worst line→page delay: ${worst} ms\n`);
await browser.close();
