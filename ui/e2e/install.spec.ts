// Hosted page with no agent running: the install panel replaces the trace UI's dead end.
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectShot } from "./harness";

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
  await page.goto(`${HOSTED}/`);
  const panel = page.locator(".install");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("curl -fsSL https://lightpath.blackpaw.studio/install.sh | sh");
  await expect(panel).toContainText("lightpath");
  await expect(panel.locator("a.agent-link")).toHaveAttribute("href", "http://127.0.0.1:47800/");
  await expect(page.locator(".chip")).not.toHaveText("connected");
  await expect(page.getByRole("button", { name: "Trace" })).toBeDisabled();
  // The hosted page dials the default local agent port.
  expect(dials[0]).toBe("ws://127.0.0.1:47800/ws");
  await expectShot(page, "install-panel.png");
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
