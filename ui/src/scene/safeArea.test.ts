import { describe, expect, it } from "vitest";
import { safeRect, toNdc, type Rect } from "./safeArea";

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

describe("safeRect", () => {
  const desktop = { w: 1280, h: 720 };
  const phone = { w: 375, h: 812 };

  it("is the whole viewport with no panels", () => {
    expect(safeRect(desktop, [])).toEqual(rect(0, 0, 1280, 720));
  });

  it("clears the left column on a wide screen (form and sheet both hug the left)", () => {
    const panels = [rect(16, 16, 396, 110), rect(16, 122, 396, 704)];
    expect(safeRect(desktop, panels)).toEqual(rect(396, 0, 1280, 720));
  });

  it("clears a right-hand column from the right edge", () => {
    expect(safeRect(desktop, [rect(900, 16, 1264, 600)])).toEqual(rect(0, 0, 900, 720));
  });

  it("keeps the band between a top form and a bottom sheet at phone width", () => {
    const panels = [rect(10, 10, 365, 120), rect(0, 438, 375, 812)];
    expect(safeRect(phone, panels)).toEqual(rect(0, 120, 375, 438));
  });

  it("ignores panels with no size (hidden)", () => {
    expect(safeRect(desktop, [rect(0, 0, 0, 0), rect(16, 16, 396, 110)])).toEqual(rect(396, 0, 1280, 720));
  });

  it("gives up on panels that would leave next to nothing", () => {
    expect(safeRect(phone, [rect(10, 10, 365, 400), rect(0, 380, 375, 812)])).toEqual(rect(0, 0, 375, 812));
  });
});

describe("toNdc", () => {
  it("maps the whole viewport to the unit square", () => {
    expect(toNdc(rect(0, 0, 1280, 720), { w: 1280, h: 720 })).toEqual({ cx: 0, cy: 0, hx: 1, hy: 1 });
  });

  it("shifts the centre right for a left column and down (negative y) for a top sheet", () => {
    const left = toNdc(rect(396, 0, 1280, 720), { w: 1280, h: 720 });
    expect(left.cx).toBeCloseTo(396 / 1280, 9);
    expect(left.hx).toBeCloseTo(884 / 1280, 9);
    const top = toNdc(rect(0, 120, 375, 438), { w: 375, h: 812 });
    expect(top.cy).toBeCloseTo(1 - (2 * 279) / 812, 9);
    expect(top.hy).toBeCloseTo(318 / 812, 9);
  });
});
