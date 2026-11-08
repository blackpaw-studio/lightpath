import { describe, expect, it } from "vitest";
import type { Vec3 } from "../geo";
import { markEntities, type DrawnMark, type GateMark } from "./marks";

const project = (p: Vec3): { x: number; y: number; inFrustum: boolean } => ({ x: p[0] * 100, y: p[1] * 100, inFrustum: p[2] > 0 });
const at = (pos: Vec3, alpha: number): DrawnMark => ({ pos, alpha });
const gate = (ring: DrawnMark, label: DrawnMark | null = null): GateMark => ({ ring, label });

describe("markEntities (what is actually drawn)", () => {
  it("a hop's marker is visible while its dot or its ring is drawn, hidden in between", () => {
    const g = (dot: number, ring: number): boolean =>
      markEntities(new Map([[1, at([0, 0, 1], dot)]]), new Map([[1, gate(at([0, 0, 1], ring))]]), project)["g:1"]!.visible;
    expect(g(0.6, 0)).toBe(true);
    expect(g(0, 0.3)).toBe(true);
    expect(g(0, 0)).toBe(false);
    expect(g(0.004, 0.004)).toBe(false);
  });

  it("is hidden outside the frustum and carries the drawn world position", () => {
    const e = markEntities(new Map([[2, at([1, 2, -1], 1)]]), new Map(), project)["g:2"]!;
    expect(e.visible).toBe(false);
    expect(e.world).toEqual([1, 2, -1]);
  });

  it("a label is its own entity at its own drawn position and opacity, absent until it is placed", () => {
    const placed = markEntities(new Map(), new Map([[3, gate(at([0, 0, 2], 1), at([0.1, 0.2, 2], 0.5))]]), project);
    expect(placed["l:3"]).toMatchObject({ visible: true, world: [0.1, 0.2, 2], x: 10, y: 20, opacity: 0.5 });
    const unplaced = markEntities(new Map(), new Map([[3, gate(at([0, 0, 2], 1))]]), project);
    expect(unplaced["l:3"]).toBeUndefined();
  });
});
