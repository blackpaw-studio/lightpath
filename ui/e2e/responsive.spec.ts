import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import { expectedRows } from "./fixtureHops";
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
  const grouped = expectedRows(FIXTURES.real.file);
  await expect(rows).toHaveCount(grouped.length);
  for (const i of [0, grouped.length - 1]) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    await expect(rows.nth(i)).toBeInViewport();
  }
  // Expanded details (long IPs, hostnames, AS names) must not push the page sideways either.
  for (let i = 0; i < grouped.length; i++) await rows.nth(i).getByRole("button").click();
  await expect(page.locator(".hop .details:visible")).toHaveCount(grouped.length);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".hops")!;
    return list.scrollWidth - list.clientWidth;
  })).toBeLessThanOrEqual(0);
  await expect(page.getByLabel("Trace target")).toBeInViewport();
  await expect(page.locator(".hud button.view")).toBeInViewport();
});
