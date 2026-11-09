// Hosted page with no agent running: the install panel replaces the trace UI's dead end.
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { RUN_CMD } from "../src/hud/install";
import { expectShot, step } from "./harness";

const HOSTED = "https://lightpath.blackpaw.studio";
const DIST = join(import.meta.dirname, "..", "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".bin": "application/octet-stream", ".sh": "text/plain",
};

/** Serves the built UI as if from Cloudflare Pages, and refuses the local agent's socket. */
const hostedWithoutAgent = async (page: Page): Promise<string[]> => {
  const dials: string[] = [];
  await page.route(`${HOSTED}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const rel = normalize(path === "/" ? "index.html" : path.slice(1));
    if (rel.startsWith("..")) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ body: await readFile(join(DIST, rel)), contentType: TYPES[extname(rel)] ?? "application/octet-stream" });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/, (ws) => {
    dials.push(ws.url());
    ws.close();
  });
  return dials;
};

test("hosted page without an agent shows the install panel", async ({ page }) => {
  const dials = await hostedWithoutAgent(page);
  // Test mode: frames advance only when stepped, so the screenshot is stable.
  await page.goto(`${HOSTED}/?test=1`);
  const panel = page.locator(".install");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(RUN_CMD);
  await expect(panel).toContainText("Downloads a small helper and starts it. Ctrl-C to stop.");
  await expect(panel.locator("a.install-link")).toHaveText("Install permanently");
  await expect(panel.locator("a.install-link")).toHaveAttribute("href", "/install.sh");
  await expect(panel.locator("a.agent-link")).toHaveAttribute("href", "http://127.0.0.1:47800/");
  await expect(page.locator(".chip")).not.toHaveText("connected");
  await expect(page.getByRole("button", { name: "Trace" })).toBeDisabled();
  // The hosted page dials the default local agent port.
  expect(dials[0]).toBe("ws://127.0.0.1:47800/ws");
  await page.waitForFunction(() => "__lightpath" in window, null, { timeout: 30_000 });
  await step(page, 1000);
  await expectShot(page, "install-panel.png");
});

// The panel must not wait for a retry series. Two ways a first dial never closes:
// it hangs (a pending Chrome Local Network Access prompt), or it errors with no close (WebKit).
const withSocket = async (page: Page, body: string): Promise<void> => {
  await page.addInitScript(`window.WebSocket = class { constructor() { ${body} } close() {} send() {} };`);
};

test("a hung first dial still shows the install panel within 1.5 s of load", async ({ page }) => {
  await hostedWithoutAgent(page);
  await withSocket(page, "");
  await page.goto(`${HOSTED}/`);
  await expect(page.locator(".install")).toBeVisible({ timeout: 2000 });
  await expect(page.locator(".install")).toContainText(RUN_CMD);
});

test("a dial that errors without ever closing shows the install panel within 1 s", async ({ page }) => {
  await hostedWithoutAgent(page);
  await withSocket(page, "setTimeout(() => this.onerror && this.onerror(new Event('error')), 5);");
  await page.goto(`${HOSTED}/`);
  await expect(page.locator(".install")).toBeVisible({ timeout: 1000 });
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("install panel fits at 375 px", async ({ page }) => {
    await hostedWithoutAgent(page);
    await page.goto(`${HOSTED}/`);
    await expect(page.locator(".install")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator(".install a.agent-link")).toBeInViewport();
  });
});
