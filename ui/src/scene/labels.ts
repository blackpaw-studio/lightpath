// Gate labels: CSS2D overlays reading "hostname · ASN/org · RTT". Hop text comes
// from reverse DNS and whois of arbitrary routers, so it is only ever set as
// textContent, never parsed as HTML.
import type { Object3D } from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { TunnelGate } from "./tunnelLayout";

const STYLE_ID = "lp-gate-label-style";
const CSS = `
.lp-gate { pointer-events: none; }
.lp-gate-card {
  display: flex; gap: 8px; align-items: baseline; white-space: nowrap;
  font: 500 11px/1.35 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color: #e6f7ff; padding: 5px 10px 6px 8px; border-radius: 2px 7px 7px 2px;
  background: linear-gradient(90deg, rgba(6, 12, 28, 0.78), rgba(6, 12, 28, 0.34));
  border-left: 2px solid var(--lp-c); box-shadow: -6px 0 22px -10px var(--lp-c);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.lp-gate[data-side="left"] .lp-gate-card {
  flex-direction: row-reverse; text-align: right; border-radius: 7px 2px 2px 7px;
  border-left: 0; border-right: 2px solid var(--lp-c); box-shadow: 6px 0 22px -10px var(--lp-c);
  background: linear-gradient(270deg, rgba(6, 12, 28, 0.78), rgba(6, 12, 28, 0.34));
}
.lp-gate-ttl { color: var(--lp-c); font-weight: 700; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; }
.lp-gate-title { max-width: 30ch; overflow: hidden; text-overflow: ellipsis; color: #f4fbff; }
.lp-gate-detail { color: #93abc4; font-size: 10px; max-width: 34ch; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 480px) {
  .lp-gate-card { font-size: 10px; padding: 4px 8px 5px 6px; gap: 6px; }
  .lp-gate-title { max-width: 17ch; }
  .lp-gate-detail { font-size: 9px; max-width: 21ch; }
}
`;

const ensureStyle = (doc: Document): void => {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
};

const el = (doc: Document, cls: string): HTMLDivElement => {
  const d = doc.createElement("div");
  d.className = cls;
  return d;
};

export interface GateLabelView {
  /** A CSS2DObject in the browser; any Object3D stands in where there is no DOM. */
  readonly object: Object3D;
  set(gate: TunnelGate, color: string): void;
  setSide(side: "left" | "right"): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

export const createGateLabel = (doc: Document = document): GateLabelView => {
  ensureStyle(doc);
  const root = el(doc, "lp-gate");
  const card = el(doc, "lp-gate-card");
  const ttl = el(doc, "lp-gate-ttl");
  const text = el(doc, "lp-gate-text");
  const title = el(doc, "lp-gate-title");
  const detail = el(doc, "lp-gate-detail");
  text.append(title, detail);
  card.append(ttl, text);
  root.append(card);
  const object = new CSS2DObject(root);
  let shown = { ttl: "", title: "", detail: "", color: "", side: "", opacity: -1 };

  return {
    object,
    set: (gate, color) => {
      const t = String(gate.ttl).padStart(2, "0");
      if (t !== shown.ttl) ttl.textContent = t;
      if (gate.title !== shown.title) title.textContent = gate.title;
      if (gate.detail !== shown.detail) detail.textContent = gate.detail;
      if (color !== shown.color) root.style.setProperty("--lp-c", color);
      shown = { ...shown, ttl: t, title: gate.title, detail: gate.detail, color };
    },
    setSide: (side) => {
      if (side === shown.side) return;
      shown = { ...shown, side };
      root.dataset.side = side;
      // Anchor the card's bottom-left (right side) or bottom-right (left side) corner at the point.
      object.center.set(side === "right" ? 0 : 1, 1);
    },
    setOpacity: (o) => {
      const q = Math.round(o * 100) / 100;
      if (q === shown.opacity) return;
      shown = { ...shown, opacity: q };
      root.style.opacity = String(q);
      object.visible = q > 0;
    },
    dispose: () => root.remove(),
  };
};
