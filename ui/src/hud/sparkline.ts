import type { Probe } from "../protocol";
import { meanRtt, rttColor } from "../color";

const NS = "http://www.w3.org/2000/svg";
const W = 240;
const H = 36;
const PAD = 4;

const svgEl = (doc: Document, tag: string, attrs: Record<string, string>): SVGElement => {
  const el = doc.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
};

/** Inline SVG of mean RTT per hop (index = hop order). Timeout-only hops are gaps. */
export const sparkline = (doc: Document, perHop: readonly (readonly Probe[])[]): SVGElement => {
  const svg = svgEl(doc, "svg", { viewBox: "0 0 " + W + " " + H, class: "spark", role: "img", "aria-label": "RTT per hop" });
  const pts = perHop.flatMap((probes, i) => {
    const m = meanRtt(probes);
    return m === null ? [] : [{ i, m }];
  });
  if (pts.length === 0) return svg;
  const max = Math.max(...pts.map((p) => p.m), 1);
  const x = (i: number): number => PAD + (perHop.length <= 1 ? 0.5 : i / (perHop.length - 1)) * (W - 2 * PAD);
  const y = (m: number): number => H - PAD - (m / max) * (H - 2 * PAD);
  svg.append(
    svgEl(doc, "polyline", {
      points: pts.map((p) => x(p.i).toFixed(1) + "," + y(p.m).toFixed(1)).join(" "),
      fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round", opacity: "0.55",
    }),
  );
  pts.forEach((p) =>
    svg.append(svgEl(doc, "circle", { cx: x(p.i).toFixed(1), cy: y(p.m).toFixed(1), r: "2.5", fill: rttColor(p.m) })),
  );
  return svg;
};
