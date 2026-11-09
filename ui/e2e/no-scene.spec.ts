// The scene fails to start (no WebGL, or its assets fail to load): the HUD
// keeps working without it, and the Dive/Surface toggle is hidden.
import { expect, test } from "@playwright/test";
import { FIXTURES, agentUrl } from "./agents";
import { expectedRows } from "./fixtureHops";

test("without a scene the HUD still traces and offers no Dive", async ({ page }) => {
  // Break scene start-up by failing the land-dot asset it loads first.
  await page.route(/\/assets\/landdots-[^/]+\.bin$/, (route) => route.fulfill({ status: 404 }));
  await page.goto(agentUrl(FIXTURES.basic, ""));
  await expect(page.locator("body")).toHaveClass(/no-scene/);
  await expect(page.locator(".hud button.view")).toBeHidden();
  await expect(page.locator("#scene")).toBeHidden();
  await expect(page.locator(".chip")).toHaveText("connected");
  await page.getByLabel("Trace target").fill("example.com");
  await page.getByRole("button", { name: "Trace" }).click();
  await expect(page.locator(".hop")).toHaveCount(expectedRows(FIXTURES.basic.file).length);
  await expect(page.locator(".hud button.view")).toBeHidden(); // still hidden once hops exist
});
