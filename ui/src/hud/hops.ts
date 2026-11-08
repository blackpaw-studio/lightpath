import type { GeoSource, Hop, Probe } from "../protocol";
import { meanRtt, rttColor } from "../color";

export type Badge = "measured" | "estimated";

export const badgeFor = (src: GeoSource): Badge => (src === "estimated" ? "estimated" : "measured");

export const rttText = (probes: readonly Probe[]): string =>
  probes.map((p) => (p.rttMs === null ? "*" : p.rttMs.toFixed(1) + " ms")).join(" · ");

const asnText = (h: Hop): string =>
  [h.asn === null ? null : "AS" + h.asn, h.org].filter((x): x is string => x !== null && x !== "").join(" ");

const cell = (doc: Document, cls: string, text: string): HTMLElement => {
  const el = doc.createElement("span");
  el.className = cls;
  el.textContent = text; // agent-supplied: textContent only
  return el;
};

/** One hop row. All data goes through textContent. */
export const hopRow = (doc: Document, hop: Hop, onFocus: (ttl: number) => void): HTMLElement => {
  const row = doc.createElement("li");
  row.className = "hop";
  row.dataset.ttl = String(hop.ttl);
  row.tabIndex = 0;
  row.style.setProperty("--rtt", rttColor(meanRtt(hop.probes)));

  const badge = badgeFor(hop.geoSource);
  const meta = [asnText(hop), hop.city ?? ""].filter((x) => x !== "").join(" · ");
  const top = doc.createElement("div");
  top.className = "hop-top";
  top.append(cell(doc, "ttl", String(hop.ttl)), cell(doc, "ip", hop.ip ?? "*"), cell(doc, "badge " + badge, badge));
  const sub = doc.createElement("div");
  sub.className = "hop-sub";
  sub.append(cell(doc, "host", hop.host ?? ""), cell(doc, "meta", meta), cell(doc, "rtt", rttText(hop.probes)));
  row.append(top, sub);

  row.addEventListener("click", () => onFocus(hop.ttl));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onFocus(hop.ttl);
    }
  });
  return row;
};
