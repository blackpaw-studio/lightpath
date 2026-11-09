import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import { call, expectShot, openApp, startTrace, step, waitForDone } from "./harness";

test("dive flies into the tunnel and focus glides to a gate", async ({ page }) => {
  await openApp(page, FIXTURES.basic);
  await startTrace(page);
  await waitForDone(page);
  await step(page, 3000);
  expect(await call<boolean>(page, "dive")).toBe(true);
  await step(page, 3200);
  expect(await call<string>(page, "mode")).toBe("tunnel");
  expect(await call<number>(page, "viewT")).toBe(1);
  await expect(page.locator(".hud button.view")).toHaveText("Surface");
  await expectShot(page, "tunnel-inside.png");

  // Clicking a hop row focuses it in the current view: the camera glides down the spline.
  await page.locator('.hop[data-ttl="5"]').getByRole("button").click();
  await expect(page.locator('.hop[data-ttl="5"]')).toHaveClass(/focus/);
  const glide = await step(page, 2600, true);
  const gate5 = glide.map((f) => f.entities["5"]!);
  const [first, last] = [gate5[0]!, gate5[gate5.length - 1]!];
  // The gate stays put in the world; only the camera moves, so its screen position changes.
  expect(last.world).toEqual(first.world);
  expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(1);
  await expect(page.locator("#labels")).toContainText("EDGECAST");
  await expectShot(page, "tunnel-focus-5.png");
});
