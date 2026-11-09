import type { Destination, GeoSource, Probe } from "../protocol";
import { meanRtt, rttColor } from "../color";
import type { LocationDoubt } from "../plausibility";
import { shortNetworkName } from "./network";
import { delayText, hasSolidLocation, medianRtt, placeLabel, type Row } from "./rows";

export const QUIET_SUBTITLE = "Many networks hide their routers; the path continues.";
export const STOPPED_SUBTITLE = "The trace stopped here; the destination didn't answer.";
export const DESTINATION_SUBTITLE = "Answers directly; routers near it stay quiet.";
export const UNANSWERING_SUBTITLE = "Doesn't answer traces; the last stretch is estimated from its IP location.";
export const END_TITLE = "The destination doesn't answer traces";

export interface RowHandlers {
  /** Called after a row flips, so the HUD can keep it open across re-renders. */
  onToggle(key: string, expanded: boolean): void;
  /** Hop rows only: also point the scene at this hop. */
  onFocus(ttl: number): void;
}

type HopRow = Extract<Row, { kind: "hop" }>;
type QuietRow = Extract<Row, { kind: "quiet" }>;
type DestinationRow = Extract<Row, { kind: "destination" }>;
type EndRow = Extract<Row, { kind: "end" }>;

export const rttText = (probes: readonly Probe[]): string =>
  probes.map((p) => (p.rttMs === null ? "*" : p.rttMs.toFixed(1) + " ms")).join(" · ");

const SOURCE_TEXT: Readonly<Record<GeoSource, string>> = {
  api: "Measured (ip-api)",
  hostname: "Measured (hostname)",
  local: "Measured (local)",
  estimated: "Estimated",
};

/** Why a database location was dropped. The wire carries a city, not a country. */
export const doubtText = (d: LocationDoubt): string =>
  `IP database says ${d.place ?? "somewhere far away"}, but a ${delayText(d.rttMs)} reply can't come from that far.`;

const asnText = (h: { asn: number | null; org: string | null }): string | null => {
  const text = [h.asn === null ? null : "AS" + h.asn, h.org].filter((x): x is string => x !== null && x !== "").join(" ");
  return text === "" ? null : text;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, cls = "", text?: string,
): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // agent-supplied: textContent only
  return e;
};

const detailList = (doc: Document, lines: readonly (readonly [string, string | null])[]): HTMLElement => {
  const dl = el(doc, "dl", "detail-list");
  for (const [label, value] of lines) {
    if (value === null || value === "") continue;
    dl.append(el(doc, "dt", "", label), el(doc, "dd", "", value));
  }
  return dl;
};

/**
 * The row is an <li>; its header is the button (details stay outside it, since a
 * button's children are presentational). Toggling flips the DOM in place and
 * reports the new state; Enter, Space and click all toggle.
 */
const assemble = (
  doc: Document, key: string, cls: string, headChildren: readonly HTMLElement[], detailEl: HTMLElement,
  expanded: boolean, afterToggle: () => void, h: RowHandlers,
): HTMLElement => {
  const li = el(doc, "li", cls);
  li.dataset.key = key;
  const head = el(doc, "div", "hop-head");
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  head.append(...headChildren);
  const details = el(doc, "div", "details");
  details.id = "details-" + key;
  details.append(detailEl);
  head.setAttribute("aria-controls", details.id);

  // The reveal animation belongs to a user toggle, not to a render: rows rebuilt while hops stream stay still.
  const clearOpening = (e: Event): void => {
    if (e.target === details) li.classList.remove("opening");
  };
  li.addEventListener("animationend", clearOpening);
  const set = (open: boolean): void => {
    head.setAttribute("aria-expanded", String(open));
    details.hidden = !open;
    li.classList.toggle("open", open);
  };
  set(expanded);
  const toggle = (): void => {
    const open = head.getAttribute("aria-expanded") !== "true";
    set(open);
    li.classList.toggle("opening", open);
    h.onToggle(key, open);
    afterToggle();
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggle();
  });
  li.append(head, details);
  return li;
};

/** A responding hop: place, one delay, and details on demand. */
export const hopRowEl = (doc: Document, row: HopRow, expanded: boolean, h: RowHandlers): HTMLElement => {
  const hop = row.hop;
  const dot = el(doc, "span", "dot " + (hasSolidLocation(hop) ? "solid" : "hollow"));
  dot.setAttribute("aria-hidden", "true");
  const rtt = medianRtt(hop.probes);
  const detail = detailList(doc, [
    ["IP", hop.ip ?? "*"],
    ["Host", hop.host],
    ["Network", asnText(hop)],
    ["Replies", rttText(hop.probes)],
    ["Location", row.doubt ? doubtText(row.doubt) : SOURCE_TEXT[hop.geoSource]],
  ]);
  const li = assemble(
    doc, row.key, "hop",
    [dot, el(doc, "span", "place", placeLabel(hop, row.doubt !== undefined)), el(doc, "span", "delay", rtt === null ? "" : delayText(rtt))],
    detail, expanded, () => h.onFocus(hop.ttl), h,
  );
  li.dataset.ttl = String(hop.ttl);
  li.style.setProperty("--rtt", rttColor(meanRtt(hop.probes)));
  return li;
};

/** A run of silent hops: one quiet line, expandable to the hop numbers. Never moves the scene. */
export const quietRowEl = (
  doc: Document, row: QuietRow, expanded: boolean, h: RowHandlers, stopped = false,
): HTMLElement => {
  const n = row.ttls.length;
  const connector = el(doc, "span", "connector");
  connector.setAttribute("aria-hidden", "true");
  const text = el(doc, "span", "quiet-text");
  text.append(
    el(doc, "span", "place", row.title ?? `${n} ${n === 1 ? "router" : "routers"} stayed quiet`),
    el(doc, "span", "subtitle", stopped ? STOPPED_SUBTITLE : QUIET_SUBTITLE),
  );
  const li = assemble(
    doc, row.key, "hop quiet", [connector, text], detailList(doc, [["Hops", row.ttls.join(", ")]]),
    expanded, () => {}, h,
  );
  li.dataset.ttls = row.ttls.join(" ");
  return li;
};

const destinationPlace = (d: Destination, answers: boolean): string => {
  // A destination that does not answer is placed from its IP location alone: always an estimate.
  const place = d.city === null ? null : (d.geoSource === "estimated" || !answers ? "≈ " : "") + d.city;
  return [
    "Destination", shortNetworkName(d.org, d.asn), place, d.rttMs === null ? null : delayText(d.rttMs),
  ].filter((x): x is string => x !== null).join(" · ");
};

/** The end of a quiet finish that answers over TCP, or is located without answering. Focuses its scene entry when the scene has one. */
export const destinationRowEl = (doc: Document, row: DestinationRow, expanded: boolean, h: RowHandlers): HTMLElement => {
  const d = row.destination;
  const dot = el(doc, "span", "dot hollow");
  dot.setAttribute("aria-hidden", "true");
  const text = el(doc, "span", "dest-text");
  text.append(
    el(doc, "span", "place", destinationPlace(d, row.answers)),
    el(doc, "span", "subtitle", row.answers ? DESTINATION_SUBTITLE : UNANSWERING_SUBTITLE),
  );
  const detail = detailList(doc, [
    ["IP", d.ip],
    ["Host", d.host],
    ["Network", asnText(d)],
    ["Reached via", d.port === null ? null : "TCP port " + d.port],
    ["Delay", d.rttMs === null ? null : delayText(d.rttMs)],
  ]);
  const li = assemble(
    doc, row.key, "hop destination", [dot, text], detail, expanded,
    () => { if (row.ttl !== null) h.onFocus(row.ttl); }, h,
  );
  if (row.ttl !== null) li.dataset.ttl = String(row.ttl);
  li.dataset.ttls = row.ttls.join(" ");
  return li;
};

/** The closing row for a quiet finish whose destination does not answer. Never moves the scene. */
export const endRowEl = (doc: Document, row: EndRow, expanded: boolean, h: RowHandlers): HTMLElement => {
  const text = el(doc, "span", "quiet-text");
  text.append(
    el(doc, "span", "place", END_TITLE),
    el(doc, "span", "subtitle", row.pastLabel === null
      ? "The path ends somewhere out of view."
      : "The path ends somewhere past " + row.pastLabel + "."),
  );
  const connector = el(doc, "span", "connector");
  connector.setAttribute("aria-hidden", "true");
  const detail = detailList(doc, [
    ["IP", row.destination?.ip ?? null],
    ["Silent hops", row.ttls.length === 0 ? null : row.ttls.join(", ")],
  ]);
  const li = assemble(doc, row.key, "hop quiet end", [connector, text], detail, expanded, () => {}, h);
  li.dataset.ttls = row.ttls.join(" ");
  return li;
};

export const rowEl = (doc: Document, row: Row, expanded: boolean, h: RowHandlers, stopped = false): HTMLElement => {
  switch (row.kind) {
    case "hop": return hopRowEl(doc, row, expanded, h);
    case "quiet": return quietRowEl(doc, row, expanded, h, stopped);
    case "destination": return destinationRowEl(doc, row, expanded, h);
    case "end": return endRowEl(doc, row, expanded, h);
  }
};
