// The hops a replay fixture's last trace ends with, folded straight from its
// events (hop sets a row, hop.update merges into it), independent of the app's reducer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLocations } from "../src/plausibility";
import type { Hop, Origin } from "../src/protocol";
import { buildRows, type Row } from "../src/hud/rows";
import { initialState } from "../src/reducer";

type Event = { type: string; ttl?: number } & Record<string, unknown>;

const lastTrace = (file: string): Event[] => {
  const { events } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", file), "utf8")) as { events: { event: Event }[] };
  const evs = events.map((e) => e.event);
  return evs.slice(evs.map((e) => e.type).lastIndexOf("trace.started"));
};

/** The hops as the agent sent them (before the speed-of-light check). */
export const expectedHops = (file: string): Hop[] => {
  const rows = new Map<number, Hop>();
  for (const { type, ...fields } of lastTrace(file).slice(1)) {
    const ttl = fields.ttl as number;
    if (type === "hop") rows.set(ttl, fields as unknown as Hop);
    if (type === "hop.update" && rows.has(ttl)) rows.set(ttl, { ...rows.get(ttl)!, ...fields });
  }
  return [...rows.values()].sort((a, b) => a.ttl - b.ttl);
};

/** The hops the views show: the agent's hops with locations the reply delay rules out dropped. */
export const expectedShown = (file: string) => {
  const origin = (lastTrace(file)[0] as unknown as { origin: Origin }).origin;
  return checkLocations({ ...initialState, origin, hops: expectedHops(file) });
};

/** The hop-list rows the HUD shows for a fixture's hops: silent runs collapsed and named, doubted locations marked. */
export const expectedRows = (file: string): readonly Row[] => buildRows(expectedShown(file));
