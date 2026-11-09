// The hops a replay fixture's last trace ends with, folded straight from its
// events (hop sets a row, hop.update merges into it), independent of the app's reducer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hop } from "../src/protocol";
import { buildRows, type Row } from "../src/hud/rows";
import { initialState } from "../src/reducer";

type Event = { type: string; ttl?: number } & Record<string, unknown>;

export const expectedHops = (file: string): Hop[] => {
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

/** The hop-list rows the HUD shows for a fixture's hops: silent runs collapsed and named. */
export const expectedRows = (file: string): readonly Row[] => buildRows({ ...initialState, hops: expectedHops(file) });
