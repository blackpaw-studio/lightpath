// Agent connection drops mid-trace: the trace ends as interrupted (the scene
// no longer shows an active trace) and the page reconnects on its own.
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { FIXTURES } from "./agents";
import { openApp, startTrace, state, step } from "./harness";

test("a dropped connection interrupts the running trace, then reconnects", async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(`ws://127.0.0.1:${FIXTURES.real.port}/ws`, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  await openApp(page, FIXTURES.real);
  await startTrace(page);
  await expect(page.locator(".hop")).not.toHaveCount(0);
  expect((await state(page)).status).toBe("running");

  await sockets[0]!.close();
  await expect.poll(async () => (await state(page)).status).toBe("error");
  const s = await state(page);
  expect(s.error?.code).toBe("disconnected");
  expect(s.hops.length).toBeGreaterThan(0); // the hops already seen stay on screen
  await expect(page.locator(".hud .error")).toContainText("trace interrupted");
  await step(page, 100); // the scene keeps stepping without a running trace

  // Backoff redials (0.5 s) through the route, and the agent accepts again.
  await expect(page.locator(".chip")).toHaveText("connected", { timeout: 10_000 });
  expect(sockets.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Trace" })).toBeEnabled();
});
