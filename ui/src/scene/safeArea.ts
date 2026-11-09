// The part of the viewport the globe may use: the viewport minus the HUD panels.
// Pure: panel rects come from the DOM (hud.observeOcclusion) and arrive here.

/** A rectangle in CSS pixels, viewport-relative. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Viewport {
  readonly w: number;
  readonly h: number;
}

/** A region of the screen in normalised device coordinates: centre and half extents (full screen: 0, 0, 1, 1). */
export interface NdcRect {
  readonly cx: number;
  readonly cy: number;
  readonly hx: number;
  readonly hy: number;
}

export const FULL_NDC: NdcRect = { cx: 0, cy: 0, hx: 1, hy: 1 };

/** A panel narrower than this share of the viewport is a side column; wider ones are top or bottom sheets. */
const COLUMN_SHARE = 0.6;
/** Panels that leave less than this share of either dimension are ignored: framing into a sliver helps nobody. */
const MIN_SHARE = 0.25;

const width = (r: Rect): number => r.right - r.left;
const height = (r: Rect): number => r.bottom - r.top;

/** Cuts the edge the panel hugs: a column from the side it is nearer, a full-width sheet from the top or bottom. */
const cut = (area: Rect, panel: Rect, view: Viewport): Rect => {
  if (width(panel) < COLUMN_SHARE * view.w) {
    const onLeft = panel.left + panel.right < view.w;
    return onLeft ? { ...area, left: Math.max(area.left, panel.right) } : { ...area, right: Math.min(area.right, panel.left) };
  }
  const onTop = panel.top + panel.bottom < view.h;
  return onTop ? { ...area, top: Math.max(area.top, panel.bottom) } : { ...area, bottom: Math.min(area.bottom, panel.top) };
};

/** The viewport with every panel's edge cut away. Hidden (zero-size) panels are skipped. */
export const safeRect = (view: Viewport, panels: readonly Rect[]): Rect => {
  const full: Rect = { left: 0, top: 0, right: view.w, bottom: view.h };
  const area = panels.filter((p) => width(p) > 0 && height(p) > 0).reduce((a, p) => cut(a, p, view), full);
  return width(area) < MIN_SHARE * view.w || height(area) < MIN_SHARE * view.h ? full : area;
};

/** CSS pixels (y down) → NDC (y up). */
export const toNdc = (r: Rect, view: Viewport): NdcRect => ({
  cx: (r.left + r.right) / view.w - 1,
  cy: 1 - (r.top + r.bottom) / view.h,
  hx: width(r) / view.w,
  hy: height(r) / view.h,
});
