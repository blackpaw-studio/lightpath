import "./styles.css";
import type { ConnState } from "../conn";
import type { MaybeShown } from "../plausibility";
import type { TraceState } from "../reducer";
import { rowEl, type RowHandlers } from "./hops";
import type { Rect } from "../scene/safeArea";
import { installPanel } from "./install";
import { buildRows, isIpLiteral, summaryLine, trailingStopKey } from "./rows";
import { sparkline } from "./sparkline";

export interface HudHandlers {
  onTrace(target: string): void;
  onCancel(): void;
  onFocusHop(ttl: number): void;
  onDive(): void;
  onSurface(): void;
}
export interface HudOptions {
  /** True on the hosted page (not agent-served): enables the install panel. */
  hosted: boolean;
  userAgent?: string;
}
export type View = "globe" | "tunnel";

export interface Hud {
  render(state: MaybeShown, conn: ConnState): void;
  /** Sync the Dive/Surface toggle with the scene's current view. */
  setView(view: View): void;
  /** Highlight a hop row (ttl), or clear with null. */
  setFocus(ttl: number | null): void;
  /**
   * Reports the viewport-relative rects of the visible panels now and whenever they
   * change (panel resize, window resize). Returns the unsubscribe.
   */
  observeOcclusion(cb: (rects: readonly Rect[]) => void): () => void;
  destroy(): void;
}

const ATTRIBUTION = "Geo: ip-api.com · ASN: Team Cymru · Map: Natural Earth";

const make = <K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, cls = "", text?: string,
): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const summary = (s: TraceState, connected: boolean): string => {
  if (s.status === "idle" || s.target === null) return "Enter a host to trace the route from here.";
  const ip = s.resolvedIp && !isIpLiteral(s.target) ? " (" + s.resolvedIp + ")" : "";
  const runningTail = connected ? " · tracing…" : " · disconnected: trace interrupted";
  const answers = s.endReason === "quiet" && s.destination?.reachable === true;
  const doneTail = s.reached ? " · reached" : answers ? " · destination answers" : " · not reached";
  const tail = s.status === "done" ? doneTail : s.status === "running" ? runningTail : "";
  return "To " + s.target + ip + tail;
};

export const mount = (root: HTMLElement, h: HudHandlers, opts: HudOptions): Hud => {
  const doc = root.ownerDocument;
  const hud = make(doc, "div", "hud");

  const form = make(doc, "form", "panel controls");
  const input = make(doc, "input");
  input.type = "text";
  input.placeholder = "example.com or 1.1.1.1";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Trace target");
  const traceBtn = make(doc, "button", "trace", "Trace");
  traceBtn.type = "submit";
  const chip = make(doc, "span", "chip");
  const head = make(doc, "div", "head");
  head.append(make(doc, "span", "brand", "Lightpath"), chip);
  const row = make(doc, "div", "input-row");
  row.append(input, traceBtn);
  form.append(head, row);

  const sheet = make(doc, "section", "panel sheet");
  const status = make(doc, "p", "summary");
  const viewBtn = make(doc, "button", "view", "Dive");
  viewBtn.type = "button";
  const sheetHead = make(doc, "div", "sheet-head");
  sheetHead.append(status, viewBtn);
  const stats = make(doc, "p", "stats");
  stats.hidden = true;
  const error = make(doc, "p", "error");
  error.hidden = true;
  const spark = make(doc, "div", "spark-wrap");
  const list = make(doc, "ol", "hops");
  sheet.append(sheetHead, stats, error, spark, list, make(doc, "p", "attribution", ATTRIBUTION));

  const ua = opts.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const install = installPanel(doc, ua);
  hud.append(form, install, sheet);
  root.append(hud);

  let view: View = "globe";
  let running = false;
  let connected = false;
  let focus: number | null = null;
  let hopCount = 0;
  let expanded: ReadonlySet<string> = new Set();

  const syncButtons = (): void => {
    traceBtn.textContent = running ? "Cancel" : "Trace";
    traceBtn.disabled = !running && !connected;
    viewBtn.textContent = view === "globe" ? "Dive" : "Surface";
    viewBtn.disabled = view === "globe" && hopCount === 0;
  };
  const applyFocus = (): void =>
    list
      .querySelectorAll<HTMLElement>(".hop")
      .forEach((r) => {
        const ttls = [...(r.dataset.ttl !== undefined ? [r.dataset.ttl] : []), ...(r.dataset.ttls ?? "").split(" ")];
        r.classList.toggle("focus", focus !== null && ttls.includes(String(focus)));
      });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (running) return h.onCancel();
    const target = input.value.trim();
    if (target !== "") h.onTrace(target);
  });
  viewBtn.addEventListener("click", () => (view === "globe" ? h.onDive() : h.onSurface()));
  const focusHop = (ttl: number): void => {
    focus = ttl;
    applyFocus();
    h.onFocusHop(ttl);
  };
  const rowHandlers: RowHandlers = {
    onToggle: (key, open) => {
      expanded = new Set(open ? [...expanded, key] : [...expanded].filter((k) => k !== key));
    },
    onFocus: focusHop,
  };
  /** Rebuilds the list but keeps the scroll offset and keyboard focus the user had. */
  const renderRows = (state: MaybeShown): void => {
    const rows = buildRows(state);
    const stopKey = trailingStopKey(state, rows);
    expanded = new Set(rows.map((r) => r.key).filter((k) => expanded.has(k)));
    const active = doc.activeElement;
    const focusedKey = active && list.contains(active) ? active.closest<HTMLElement>("li")?.dataset.key : undefined;
    const scrollTop = list.scrollTop;
    list.replaceChildren(...rows.map((r) => rowEl(doc, r, expanded.has(r.key), rowHandlers, r.key === stopKey)));
    list.scrollTop = scrollTop;
    if (focusedKey !== undefined) {
      [...list.children].find((li) => (li as HTMLElement).dataset.key === focusedKey)
        ?.querySelector<HTMLElement>('[role="button"]')?.focus({ preventScroll: true });
    }
  };

  return {
    render(state, conn) {
      connected = conn.status === "connected";
      running = state.status === "running" && connected;
      hopCount = state.hops.length;
      chip.textContent = conn.status;
      chip.className = "chip " + conn.status;
      status.textContent = summary(state, connected);
      error.hidden = state.error === null;
      error.textContent = state.error?.message ?? "";
      install.hidden = !(opts.hosted && conn.status !== "connected" && conn.slow);
      sheet.classList.toggle("empty", state.hops.length === 0);
      stats.hidden = state.status !== "done";
      stats.textContent = state.status === "done" ? summaryLine(state) : "";
      renderRows(state);
      spark.replaceChildren(...(state.hops.length > 1 ? [sparkline(doc, state.hops.map((x) => x.probes))] : []));
      applyFocus();
      syncButtons();
    },
    setView(v) {
      view = v;
      syncButtons();
    },
    setFocus(ttl) {
      focus = ttl;
      applyFocus();
    },
    observeOcclusion(cb) {
      const panels = [...hud.querySelectorAll<HTMLElement>(".panel")];
      let last = "";
      const emit = (): void => {
        const rects = panels.map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
          .map((r): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
        const key = JSON.stringify(rects);
        if (key === last) return;
        last = key;
        cb(rects);
      };
      const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(emit);
      panels.forEach((p) => resizes?.observe(p));
      const win = doc.defaultView;
      win?.addEventListener("resize", emit);
      emit();
      return () => {
        resizes?.disconnect();
        win?.removeEventListener("resize", emit);
      };
    },
    destroy() {
      hud.remove();
    },
  };
};
