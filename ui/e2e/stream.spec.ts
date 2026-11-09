// Hops arriving mid-flight: a late hop.update with geo, and neighbours
// re-estimating, move nodes on the globe. Those moves must glide, never snap,
// and nothing may blink while the trace streams in.
import { expect, test } from "@playwright/test";
import { latLonToVec3, type Vec3 } from "../src/geo";
import { ORIGIN_KEY, rotateY } from "../src/scene/globePoses";
import { FIXTURES } from "./agents";
import { expectedRows } from "./fixtureHops";
import {
  byGeneration, ttlOf, expectArcsSmooth, expectSmooth, openApp, pathExtent, startTrace, state, stepLive, STREAM_MAX_JUMP_WORLD, traceOptions,
} from "./harness";

const TAIL_MS = 1500;
/** Restart: long enough after hop 4's late geo for its glide to settle within 1e-3. */
const SETTLE_TAIL_MS = 3000;

const TORONTO = latLonToVec3(43.65, -79.38);
const CHICAGO = latLonToVec3(41.88, -87.63);
const LOS_ANGELES = latLonToVec3(34.05, -118.24);

/** The globe's idle rotation about +y, recovered from where the origin (Toronto) is drawn. */
const rotationFromOrigin = (origin: Vec3): number =>
  Math.atan2(origin[0], origin[2]) - Math.atan2(TORONTO[0], TORONTO[2]);

/** Strips the generation prefix byGeneration adds ("2:g:5" → "g:5"). */
const ttlOfKeyed = (id: string): number => ttlOf(id.replace(/^\d+:(?=(?:[gla]:)?\d+$)/, ""));

test("basic: late geo updates and re-estimation glide", async ({ page }) => {
  await openApp(page, FIXTURES.basic);
  await startTrace(page);
  const frames = byGeneration(await stepLive(page, TAIL_MS));
  // Hop 5 arrives estimated, then hop.update places it in Los Angeles; hops 3–4 re-estimate around it.
  expect(pathExtent(frames, "1:5")).toBeGreaterThan(0.05);
  expect(pathExtent(frames, "1:4")).toBeGreaterThan(0.01);
  expectSmooth(frames, traceOptions(STREAM_MAX_JUMP_WORLD));
});

test("restart: a cross-ocean relocation glides and a new trace replaces the old one cleanly", async ({ page }) => {
  await openApp(page, FIXTURES.restart);
  await startTrace(page);
  const frames = byGeneration(await stepLive(page, SETTLE_TAIL_MS));

  // Hop 3 of the first trace was placed by estimate, then the API put it in Frankfurt.
  expect(pathExtent(frames, "1:3")).toBeGreaterThan(0.5);
  expectSmooth(frames, traceOptions(STREAM_MAX_JUMP_WORLD));
  expectArcsSmooth(frames);

  // The restart: generation 2 owns the scene; generation 1's hops are gone.
  const s = await state(page);
  expect(s).toMatchObject({ generation: 2, status: "done", target: "example.com" });
  expect(s.hops.map((h) => h.ttl)).toEqual([1, 2, 3, 4]);
  const last = frames[frames.length - 1]!;
  // Generation 1 reached hop 5 (Paris); generation 2 stops at 4. Nothing of hop 5 may survive the restart.
  expect(Object.keys(last.entities).filter((k) => ttlOfKeyed(k) === 5)).toEqual([]);
  // Keys alone cannot tell the traces apart (both use TTLs 1–4): check where the hops are drawn.
  const rot = rotationFromOrigin(last.entities[String(ORIGIN_KEY)]!.world!);
  const at = (id: string): Vec3 => last.entities[id]!.world! as Vec3;
  for (const [id, where] of [["2:2", CHICAGO], ["2:4", LOS_ANGELES]] as const) {
    const want = rotateY(where, rot);
    expect(Math.hypot(...at(id).map((v, i) => v - want[i]!)), `${id} drawn at its generation-2 location`).toBeLessThan(1e-3);
  }
  expect(Object.keys(last.entities).filter((k) => !/[gla]:/.test(k)).sort())
    .toEqual(["0", "2:1", "2:2", "2:3", "2:4"]);
  expect(Object.keys(last.entities).filter((k) => k.includes("g:")).sort()).toEqual(["2:g:1", "2:g:2", "2:g:3", "2:g:4", "g:0"]);
  await expect(page.locator(".hop")).toHaveCount(expectedRows(FIXTURES.restart.file).length);
});

test("real macOS recording: hops and enrichment stream in smoothly", async ({ page }) => {
  test.slow(); // the recording runs ~11 s in real time
  await openApp(page, FIXTURES.real);
  await startTrace(page);
  const frames = byGeneration(await stepLive(page, TAIL_MS));
  expectSmooth(frames, traceOptions(STREAM_MAX_JUMP_WORLD));
  expect((await state(page)).status).toBe("done");
});
