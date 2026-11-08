import { expect, test } from "@playwright/test";
import { worldJumpBound } from "../src/scene/motionBudget";
import { FIXTURES } from "./agents";
import { call, expectSmooth, openApp, startTrace, step, traceOptions, waitForDone, type GenFrame } from "./harness";

/**
 * Dive → focus the last hop → dwell → surface, recording every 1/60 s frame.
 * The dwell matters: surfacing reverses back through the gates the focus glide
 * passed, so they need over a second behind the camera before the reversal.
 */
const flight = async (page: import("@playwright/test").Page) => {
  await openApp(page, FIXTURES.basic);
  await startTrace(page);
  await waitForDone(page);
  await step(page, 3000);
  const frames: GenFrame[] = [...await step(page, 1000, true)];
  const globeAt = frames.length - 1;
  expect(await call<boolean>(page, "dive")).toBe(true);
  frames.push(...await step(page, 3200, true));
  const tunnelAt = frames.length - 1;
  expect(await call<string>(page, "mode")).toBe("tunnel");
  await expect(page.locator(".hud button.view")).toHaveText("Surface");
  expect(await call<boolean>(page, "focusHop", 5)).toBe(true);
  frames.push(...await step(page, 2600, true));
  frames.push(...await step(page, 1600, true)); // ≥1.5 s dwell in the tunnel after focus
  await call(page, "surface");
  frames.push(...await step(page, 5000, true));
  expect(await call<string>(page, "mode")).toBe("globe");
  await expect(page.locator(".hud button.view")).toHaveText("Dive");
  return { frames, globeAt, tunnelAt };
};

test("dive and surface are one continuous move: no jumps, no flicker", async ({ page }) => {
  const { frames, globeAt, tunnelAt } = await flight(page);
  // 48 px/frame at 1280 px (motionBudget: derived from peak camera speed); world bound from the route's longest flight.
  const maxJumpWorld = worldJumpBound(frames[globeAt]!, frames[tunnelAt]!);
  expect(maxJumpWorld).toBeGreaterThan(0);
  expect(frames.some((f) => f.cut)).toBe(false);
  expectSmooth(frames, traceOptions(maxJumpWorld));
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("crossfades on declared cuts, stays continuous otherwise, and never idles the globe", async ({ page }) => {
    const { frames, globeAt, tunnelAt } = await flight(page);
    // The camera cuts instead of flying: those frames are declared, so their screen jump is exempt.
    expect(frames.filter((f) => f.cut).length).toBeGreaterThanOrEqual(2);
    expectSmooth(frames, traceOptions(worldJumpBound(frames[globeAt]!, frames[tunnelAt]!)));
    // No idle rotation: the origin does not move on the globe after the trace is done.
    const idle = frames.slice(0, globeAt + 1).map((f) => f.entities["0"]!.world!);
    expect(idle[idle.length - 1]).toEqual(idle[0]);
  });
});
