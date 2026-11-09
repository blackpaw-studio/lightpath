// Spec success criterion 2 (amended by the friendlier-ux spec): every hop row shows a place, a
// delay and a measured/estimated dot up front, and expands to full detail: IP, reverse DNS,
// ASN/org, every probe time and the location source. Silent hops collapse into quiet rows.
import { expect, test } from "@playwright/test";
import type { Hop } from "../src/protocol";
import { FIXTURES, type Agent } from "./agents";
import { expectedHops, expectedRows } from "./fixtureHops";
import { openApp, startTrace, waitForDone } from "./harness";

const rtts = (h: Hop): string => h.probes.map((p) => (p.rttMs === null ? "*" : p.rttMs.toFixed(1) + " ms")).join(" · ");
const median = (h: Hop): number => {
  const xs = h.probes.flatMap((p) => (p.rttMs === null ? [] : [p.rttMs])).sort((a, b) => a - b);
  return xs.length % 2 ? xs[xs.length >> 1]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;
};

const delay = (h: Hop): string => (median(h) < 0.5 ? "<1 ms" : Math.round(median(h)) + " ms");

const CASES: [string, Agent][] = [["basic", FIXTURES.basic], ["real", FIXTURES.real]];

for (const [name, agent] of CASES) {
  test(`${name}: rows are friendly up front and carry every field in the details`, async ({ page }) => {
    test.slow(name === "real", "the recording runs ~11 s in real time");
    await openApp(page, agent);
    await startTrace(page);
    await waitForDone(page);
    const rows = expectedRows(agent.file);
    expect(rows.length).toBeGreaterThan(0);
    const list = page.locator(".hop");
    await expect(list).toHaveCount(rows.length);
    for (const [i, r] of rows.entries()) {
      const row = list.nth(i);
      const button = row.getByRole("button");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(row.locator(".details")).toBeHidden();
      if (r.kind === "quiet") {
        const n = r.ttls.length;
        await expect(row.locator(".place")).toHaveText(r.title ?? `${n} ${n === 1 ? "router" : "routers"} stayed quiet`);
        await expect(row).toContainText("Many networks hide their routers; the path continues.");
        await button.click();
        await expect(row.locator(".details")).toContainText(r.ttls.join(", "));
        continue;
      }
      if (r.kind !== "hop") throw new Error("fixture ends with an unexpected " + r.kind + " row");
      const h = r.hop;
      await expect(row.locator(".dot")).toHaveClass(h.geoSource === "estimated" ? /hollow/ : /solid/);
      await expect(row.locator(".delay")).toHaveText(delay(h));
      if (h.city !== null) await expect(row.locator(".place")).toContainText((h.geoSource === "estimated" ? "≈ " : "") + h.city);
      // Raw technical fields stay out of the collapsed row (a hop with no place or network shows its IP as the label).
      if (h.city !== null || h.org !== null || h.asn !== null) await expect(button).not.toContainText(h.ip ?? "*");
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      const d = row.locator(".details");
      await expect(d).toBeVisible();
      await expect(d).toContainText(h.ip ?? "*");
      await expect(d).toContainText(rtts(h));
      await expect(d).toContainText(h.geoSource === "estimated" ? "Estimated" : "Measured");
      if (h.host !== null) await expect(d).toContainText(h.host);
      if (h.asn !== null) await expect(d).toContainText("AS" + h.asn + (h.org ? " " + h.org : ""));
    }
    // Both dot kinds (the basic fixture has an estimated, responding hop) and at least one reverse-DNS name appear.
    if (name === "basic") await expect(page.locator(".hop .dot.hollow").first()).toBeAttached();
    await expect(page.locator(".hop .dot.solid").first()).toBeAttached();
    expect(expectedHops(agent.file).some((h) => h.host !== null)).toBe(true);
  });
}

test("real: places, networks and the plain summary line read naturally", async ({ page }) => {
  test.slow(); // the recording runs ~11 s in real time
  await openApp(page, FIXTURES.real);
  await startTrace(page);
  await waitForDone(page);
  const places = page.locator(".hop .place");
  await expect(places.nth(0)).toHaveText("Your router · Brooklyn");
  await expect(places.nth(1)).toHaveText("Verizon · New York");
  await expect(places.nth(3)).toHaveText("1 router stayed quiet");
  await expect(places.nth(6)).toHaveText("Cloudflare · South Brisbane");
  await expect(page.locator(".summary")).toHaveText("To 1.1.1.1 · reached"); // an IP target is not repeated in parens
  await expect(page.locator(".stats")).toHaveText("7 hops · 2 networks · 6 ms");
});
