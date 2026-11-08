// Spec success criterion 2: every hop shows TTL, IP, RTTs, reverse DNS,
// ASN/org and a location marked measured or estimated.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Hop } from "../src/protocol";
import { FIXTURES, type Agent } from "./agents";
import { openApp, startTrace, waitForDone } from "./harness";

type Event = { type: string; ttl?: number } & Record<string, unknown>;

/**
 * The hops a fixture's last trace ends with, folded straight from its events
 * (hop sets a row, hop.update merges into it), independent of the app's reducer.
 */
const expectedHops = (file: string): Hop[] => {
  const { events } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", file), "utf8")) as { events: { event: Event }[] };
  const evs = events.map((e) => e.event);
  const start = evs.map((e) => e.type).lastIndexOf("trace.started");
  const rows = new Map<number, Hop>();
  for (const { type, ...fields } of evs.slice(start + 1)) {
    const ttl = fields.ttl as number;
    if (type === "hop") rows.set(ttl, fields as unknown as Hop);
    if (type === "hop.update" && rows.has(ttl)) rows.set(ttl, { ...rows.get(ttl)!, ...fields });
  }
  return [...rows.values()].sort((a, b) => a.ttl - b.ttl);
};

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
    const hops = expectedHops(agent.file);
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
