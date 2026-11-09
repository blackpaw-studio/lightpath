// A trace that stops early ends honestly: a firewalled destination closes the
// list; one that answers over TCP gets a destination row, an estimated arc and
// an estimated last gate. Quiet gaps are named by their neighbours.
import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import {
  byGeneration, call, expectShot, expectSmooth, openApp, pathExtent, poseIds, startTrace, state, step, stepLive, STREAM_MAX_JUMP_WORLD,
  traceOptions, waitForDone,
} from "./harness";

const SETTLE_MS = 6000;
const DESTINATION_TTL = 14; // quiet-reachable: hops 1–13, so the destination sits one past
const TAIL_MS = 4000; // long enough for the trailing quiet hops to finish gliding toward the destination

test("firewalled: the list closes with the honest ending and the scene has no destination", async ({ page }) => {
  await openApp(page, FIXTURES.firewalled);
  await startTrace(page, "74.101.2.152");
  await waitForDone(page);
  const frames = await step(page, SETTLE_MS, true);

  await expect(page.locator(".summary")).toHaveText("To 74.101.2.152 · not reached");
  await expect(page.locator(".stats")).toHaveText("2 hops · 1 network");
  const rows = page.locator(".hops .hop");
  await expect(rows).toHaveCount(3); // router, Verizon, closing row
  await expect(rows.nth(2).locator(".place")).toHaveText("The destination doesn't answer traces");
  await expect(rows.nth(2).locator(".subtitle")).toHaveText("The path ends somewhere past Verizon · New York.");
  await expect(page.getByText("stayed quiet")).toHaveCount(0);

  const s = await state(page);
  expect(s).toMatchObject({ status: "done", endReason: "quiet", reached: false });
  // Hops 1–7 are drawn (the quiet ones estimated); nothing past them.
  expect(poseIds(frames[frames.length - 1]!)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
});

test("reachable: a named gap, a destination row, and an estimated arc and gate", async ({ page }) => {
  await openApp(page, FIXTURES.quietReachable);
  await startTrace(page, "cdn.example.net");
  await waitForDone(page);
  const frames = await step(page, SETTLE_MS, true);

  await expect(page.locator(".summary")).toHaveText("To cdn.example.net (104.16.1.1) · destination answers");
  await expect(page.locator(".stats")).toHaveText("9+ hops · 2 networks");
  const places = page.locator(".hops .hop .place");
  await expect(places).toHaveText([
    "Your router · Brooklyn",
    "Verizon · New York",
    "Verizon · Boston",
    "3 routers inside Verizon's network",
    "Verizon · Newark",
    "Cloudflare · Newark",
    "Destination · Cloudflare · San Francisco · 9 ms",
  ]);
  const dest = page.locator(".hop.destination");
  await expect(dest.locator(".subtitle")).toHaveText("Answers directly; routers near it stay quiet.");
  await dest.getByRole("button").click();
  await expect(dest.locator(".details")).toContainText("TCP port 443");

  // The scene draws the destination (pose and marker) one past the last hop.
  const last = frames[frames.length - 1]!;
  expect(poseIds(last)).toContain(String(DESTINATION_TTL));
  expect(last.entities[String(DESTINATION_TTL)]!.visible).toBe(true);
  expect(last.entities[`g:${DESTINATION_TTL}`]?.visible).toBe(true);
  await expectShot(page, "globe-quiet-done-1280.png");
});

test("reachable: the tunnel's last gate is the destination", async ({ page }) => {
  await openApp(page, FIXTURES.quietReachable);
  await startTrace(page, "cdn.example.net");
  await waitForDone(page);
  await step(page, 3000);
  expect(await call<boolean>(page, "dive")).toBe(true);
  await step(page, 3200);
  expect(await call<string>(page, "mode")).toBe("tunnel");

  // Clicking the destination row glides the camera to that gate and brings its label up.
  await page.locator(".hop.destination").getByRole("button").click();
  await expect(page.locator(".hop.destination")).toHaveClass(/focus/);
  await step(page, 3000);
  await expect(page.locator("#labels")).toContainText("Destination");
  await expect(page.locator("#labels")).toContainText("Cloudflare");
  await expectShot(page, "tunnel-destination.png");
});

test("reachable: the trace ending moves nothing abruptly and flickers nothing", async ({ page }) => {
  await openApp(page, FIXTURES.quietReachable);
  await startTrace(page, "cdn.example.net");
  const frames = byGeneration(await stepLive(page, TAIL_MS));
  expect((await state(page)).endReason).toBe("quiet");
  // The trailing quiet hops spread toward the destination when the trace ends: a real move, and a smooth one.
  expect(pathExtent(frames, "1:11")).toBeGreaterThan(0.05);
  expectSmooth(frames, traceOptions(STREAM_MAX_JUMP_WORLD));
});
