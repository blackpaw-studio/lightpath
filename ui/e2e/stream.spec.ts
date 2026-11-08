// Hops arriving mid-flight: a late hop.update with geo, and neighbours
// re-estimating, move nodes on the globe. Those moves must glide, never snap,
// and nothing may blink while the trace streams in.
import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import {
  byGeneration, checkGlides, expectSmooth, openApp, pathExtent, startTrace, state, stepLive, traceOptions,
} from "./harness";

const TAIL_MS = 1500;

test("basic: late geo updates and re-estimation glide", async ({ page }) => {
  await openApp(page, FIXTURES.basic);
  await startTrace(page);
  const frames = byGeneration(await stepLive(page, TAIL_MS));
  // Hop 5 arrives estimated, then hop.update places it in Los Angeles; hops 3–4 re-estimate around it.
  expect(pathExtent(frames, "1:5")).toBeGreaterThan(0.05);
  expect(pathExtent(frames, "1:4")).toBeGreaterThan(0.01);
  expectSmooth(frames, traceOptions(), checkGlides(frames));
});

test("restart: a cross-ocean relocation glides and a new trace replaces the old one cleanly", async ({ page }) => {
  await openApp(page, FIXTURES.restart);
  await startTrace(page);
  const frames = byGeneration(await stepLive(page, TAIL_MS));

  // Hop 3 of the first trace was placed by estimate, then the API put it in Frankfurt.
  expect(pathExtent(frames, "1:3")).toBeGreaterThan(0.5);
  expectSmooth(frames, traceOptions(), checkGlides(frames));

  // The restart: generation 2 owns the scene; generation 1's hops are gone.
  const s = await state(page);
  expect(s).toMatchObject({ generation: 2, status: "done", target: "example.com" });
  expect(s.hops.map((h) => h.ttl)).toEqual([1, 2, 3, 4]);
  const last = frames[frames.length - 1]!;
  expect(Object.keys(last.entities).sort()).toEqual(["0", "2:1", "2:2", "2:3", "2:4"]);
  await expect(page.locator(".hop")).toHaveCount(4);
});

test("real macOS recording: hops and enrichment stream in smoothly", async ({ page }) => {
  test.slow(); // the recording runs ~11 s in real time
  await openApp(page, FIXTURES.real);
  await startTrace(page);
  const frames = byGeneration(await stepLive(page, TAIL_MS));
  expectSmooth(frames, traceOptions(), checkGlides(frames));
  expect((await state(page)).status).toBe("done");
});
