import { defineConfig, devices } from "@playwright/test";
import { FIXTURES } from "./e2e/agents";

// One replay agent per fixture (the agent replays a single file), on
// LIGHTPATH_E2E_PORT_BASE + 0..5 (default 47811). Build the
// binary first: `make build` (or `make e2e`, which builds and runs this).
//
// Browsers: Chromium and WebKit run on the shared Apollo server when
// PW_TEST_CONNECT_WS_ENDPOINT is set; Firefox is not available there and runs
// locally (`--project=firefox`). Screenshot assertions only run locally on
// macOS against committed darwin baselines (see e2e/harness.ts).
const remote = Boolean(process.env.PW_TEST_CONNECT_WS_ENDPOINT);

// Headless Firefox has no WebGL on Linux (Mozilla bug 1375585), so the scene never
// starts. CI runs it headed under xvfb (`xvfb-run`) with LIGHTPATH_E2E_FIREFOX_HEADED=1;
// software GL (llvmpipe) then provides the context. macOS headless Firefox has WebGL.
const firefoxLaunch = process.env.LIGHTPATH_E2E_FIREFOX_HEADED
  ? { headless: false, launchOptions: { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false } } }
  : {};

const desktop = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 4, // the Apollo server's browsers share an 8 GB cap: never more than 4
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  webServer: Object.values(FIXTURES).map((f) => ({
    command: `../lightpath --replay e2e/fixtures/${f.file} --no-open --port ${f.port}`,
    url: `http://127.0.0.1:${f.port}/`,
    // Never reuse: a server already on this port may be another worktree's agent
    // serving a different build. Use LIGHTPATH_E2E_PORT_BASE to run side by side.
    reuseExistingServer: false,
    stdout: "ignore" as const,
    stderr: "pipe" as const,
    timeout: 15_000,
  })),
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...desktop } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ...desktop } },
    ...(remote ? [] : [{ name: "firefox", use: { ...devices["Desktop Firefox"], ...desktop, ...firefoxLaunch } }]),
  ],
});
