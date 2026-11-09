// A long-haul trace (Brooklyn to Moscow): the camera frames the whole path in the area the
// HUD leaves free, an impossible geo-IP location becomes an estimate, and names read well.
import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import {
  byGeneration, call, expectArcsSmooth, expectClearOfPanels, expectFacingAndSafe, expectShot, expectSmooth, openApp, startTrace, state, step, stepLive,
  STREAM_MAX_JUMP_WORLD, traceOptions, waitForDone,
} from "./harness";

const TAIL_MS = 6000; // the camera settles well inside this

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("every node faces the camera and sits in the free area, during and after the trace", async ({ page }) => {
      await openApp(page, FIXTURES.longHaul);
      await startTrace(page, "yandex.com");
      const frames = await stepLive(page, TAIL_MS);
      expect(await state(page)).toMatchObject({ status: "done", reached: true });
      expectClearOfPanels(frames);
      await expectFacingAndSafe(page, frames[frames.length - 1]!);
      expectSmooth(byGeneration(frames), traceOptions(STREAM_MAX_JUMP_WORLD));
      expectArcsSmooth(byGeneration(frames));
    });
  });
}

test("the whole path is in view at 1280×720", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openApp(page, FIXTURES.longHaul);
  await startTrace(page, "yandex.com");
  await waitForDone(page);
  await step(page, TAIL_MS);
  await expectShot(page, "globe-long-haul-1280.png");
});

test("a location the reply delay rules out becomes an estimate, with the reason in its details", async ({ page }) => {
  await openApp(page, FIXTURES.longHaul);
  await startTrace(page, "yandex.com");
  await waitForDone(page);
  await step(page, 500);

  const row = page.locator('.hop[data-ttl="3"]'); // 1.1.1.1 answers in 10 ms yet the database says Brisbane
  await expect(row.locator(".dot")).toHaveClass(/hollow/);
  await expect(row.locator(".place")).toHaveText("Cloudflare · ≈");
  await row.getByRole("button").click();
  await expect(row.locator(".details")).toContainText("IP database says Brisbane, but a 10 ms reply can't come from that far.");
  // The raw state keeps what the agent sent; only the drawing changes.
  expect((await state(page)).hops[2]).toMatchObject({ city: "Brisbane", geoSource: "api" });
});

test("names come from the org's description: PCCW Global and Yandex", async ({ page }) => {
  await openApp(page, FIXTURES.longHaul);
  await startTrace(page, "yandex.com");
  await waitForDone(page);
  const places = page.locator(".hop .place");
  await expect(places).toHaveText([
    "Your router · Brooklyn",
    "Verizon · New York",
    "Cloudflare · ≈",
    "Arelion · London",
    "Arelion · Frankfurt",
    "Arelion · Stockholm",
    "PCCW Global · Lagos",
    "2 routers between PCCW Global and Yandex",
    "Yandex · Moscow",
  ]);
  await expect(page.locator(".summary")).toHaveText("To yandex.com (77.88.55.88) · reached");
  await expect(page.locator(".stats")).toHaveText("10 hops · 5 networks · 125 ms");
  expect(await call<string>(page, "mode")).toBe("globe");
});
