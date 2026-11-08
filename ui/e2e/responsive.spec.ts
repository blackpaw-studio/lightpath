import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import { openApp, startTrace, step, waitForDone } from "./harness";

test.use({ viewport: { width: 375, height: 812 } });

test("375 px: no horizontal overflow and every hop row is reachable", async ({ page }) => {
  test.slow(); // the recording runs ~11 s in real time
  await openApp(page, FIXTURES.real);
  await startTrace(page);
  await waitForDone(page);
  await step(page, 1000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const rows = page.locator(".hop");
  await expect(rows).toHaveCount(7);
  for (const i of [0, 6]) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    await expect(rows.nth(i)).toBeInViewport();
  }
  await expect(page.getByLabel("Trace target")).toBeInViewport();
  await expect(page.locator(".hud button.view")).toBeInViewport();
});
