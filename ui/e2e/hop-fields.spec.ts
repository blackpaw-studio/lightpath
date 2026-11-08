// Spec success criterion 2: every hop shows TTL, IP, RTTs, reverse DNS,
// ASN/org and a location marked measured or estimated.
import { expect, test } from "@playwright/test";
import type { Hop } from "../src/protocol";
import { FIXTURES, type Agent } from "./agents";
import { openApp, startTrace, state, waitForDone } from "./harness";

const rtts = (h: Hop): string => h.probes.map((p) => (p.rttMs === null ? "*" : `${p.rttMs.toFixed(1)} ms`)).join(" · ");
const meta = (h: Hop): string =>
  [[h.asn === null ? null : `AS${h.asn}`, h.org].filter(Boolean).join(" "), h.city ?? ""].filter((x) => x !== "").join(" · ");

const CASES: [string, Agent][] = [["basic", FIXTURES.basic], ["real", FIXTURES.real]];

for (const [name, agent] of CASES) {
  test(`${name}: every row carries every field`, async ({ page }) => {
    test.slow(name === "real", "the recording runs ~11 s in real time");
    await openApp(page, agent);
    await startTrace(page);
    await waitForDone(page);
    const { hops } = await state(page);
    expect(hops.length).toBeGreaterThan(0);
    const rows = page.locator(".hop");
    await expect(rows).toHaveCount(hops.length);
    for (const [i, h] of hops.entries()) {
      const row = rows.nth(i);
      await expect(row.locator(".ttl")).toHaveText(String(h.ttl));
      await expect(row.locator(".ip")).toHaveText(h.ip ?? "*");
      await expect(row.locator(".rtt")).toHaveText(rtts(h));
      await expect(row.locator(".host")).toHaveText(h.host ?? "");
      await expect(row.locator(".meta")).toHaveText(meta(h));
      await expect(row.locator(".badge")).toHaveText(h.geoSource === "estimated" ? "estimated" : "measured");
    }
    // Both badges and at least one reverse-DNS name appear.
    await expect(page.locator(".hop .badge.estimated").first()).toBeAttached();
    await expect(page.locator(".hop .badge.measured").first()).toBeAttached();
    expect(hops.some((h) => h.host !== null)).toBe(true);
  });
}
