import { describe, expect, it } from "vitest";
import { Group, Sprite, Texture } from "three";
import type { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { latLonToVec3, slerpGreatCircle } from "../geo";
import { createArcs, type ArcInfo } from "./arcs";
import type { Pose } from "./globePoses";
import { targetShapes } from "./arcShape";
import type { LaidHop } from "./layout";

const pose = (lat: number, lon: number): Pose => ({ pos: latLonToVec3(lat, lon), scale: 1, opacity: 1 });
const arc: ArcInfo = { from: 0, to: 1, colorFrom: "#ffffff", colorTo: "#22e6ff", estimated: false };
/** Poses carrying the arc shapes the globe source would give them: hops 1…n, `located` marks the anchors. */
const shaped = (poses: ReadonlyMap<number, Pose>, located: readonly number[]): Map<number, Pose> => {
  const hops = [...poses.keys()].filter((k) => k > 0).map((ttl): LaidHop =>
    ({ ttl, pos: poses.get(ttl)!.pos, estimated: !located.includes(ttl), located: located.includes(ttl), timeout: false, rttMs: null, color: "#fff" }));
  const targets = targetShapes(hops, new Map([...poses].map(([k, p]) => [k, p.pos])), 0);
  return new Map([...poses].map(([k, p]) => [k, targets.get(k) ? { ...p, arcIn: targets.get(k)!.shape } : p]));
};
const heads = (g: Group): Sprite[] => g.children.filter((c): c is Sprite => c instanceof Sprite);

describe("createArcs", () => {
  it("replays the travelling pulse when a new trace reuses the ttl", () => {
    const parent = new Group();
    const arcs = createArcs(parent, () => new Texture());
    const poses = new Map([[0, pose(40, -74)], [1, pose(51, 0)]]);
    arcs.update(poses, [arc], 0, false, 1);
    arcs.update(poses, [arc], 5000, false, 1);
    expect(heads(parent).some((h) => h.visible)).toBe(false); // pulse finished

    arcs.update(new Map([[0, pose(40, -74)], [1, pose(35, 139)]]), [arc], 5016, false, 2);
    expect(heads(parent)).toHaveLength(1);
    expect(heads(parent)[0]!.visible).toBe(true);
  });

  it("draws a run of estimated hops as one altitude hump, not one per arc", () => {
    const parent = new Group();
    const arcs = createArcs(parent, () => new Texture());
    const a = latLonToVec3(-30, -20), b = latLonToVec3(55.75, 37.62);
    const at = (t: number): Pose => ({ pos: slerpGreatCircle(a, b, t), scale: 1, opacity: 1 });
    const poses = new Map([[1, at(0)], [2, at(1 / 3)], [3, at(2 / 3)], [4, at(1)]]);
    const infos: ArcInfo[] = [1, 2, 3].map((from) => ({
      from, to: from + 1, colorFrom: "#ffffff", colorTo: "#22e6ff", estimated: true,
          }));
    arcs.update(shaped(poses, [1, 4]), infos, 0, true, 1);
    const lines = parent.children.filter((c): c is LineSegments2 => "isLineSegments2" in c);
    const radii = lines.flatMap((l) => {
      const start = l.geometry.getAttribute("instanceStart");
      return Array.from({ length: start.count }, (_, i) => Math.hypot(start.getX(i), start.getY(i), start.getZ(i)));
    });
    const dir = radii.slice(1).map((r, i) => r - radii[i]!).filter((d) => Math.abs(d) > 1e-6);
    expect(dir.slice(1).filter((d, i) => Math.sign(d) !== Math.sign(dir[i]!))).toHaveLength(1);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(1 - 1e-6);
  });

  it("still forms one hump when the hops sit unevenly, as delay placement puts them (10 ms hop next to its 9 ms anchor)", () => {
    const parent = new Group();
    const arcs = createArcs(parent, () => new Texture());
    const a = latLonToVec3(-30, -20), b = latLonToVec3(55.75, 37.62);
    const at = (t: number): Pose => ({ pos: slerpGreatCircle(a, b, t), scale: 1, opacity: 1 });
    const poses = new Map([[1, at(0)], [2, at(1 / 63)], [3, at(0.4)], [4, at(1)]]);
    const infos: ArcInfo[] = [1, 2, 3].map((from) => ({
      from, to: from + 1, colorFrom: "#ffffff", colorTo: "#22e6ff", estimated: true,
          }));
    arcs.update(shaped(poses, [1, 4]), infos, 0, true, 1);
    const lines = parent.children.filter((c): c is LineSegments2 => "isLineSegments2" in c);
    const radii = lines.flatMap((l) => {
      const start = l.geometry.getAttribute("instanceStart");
      return Array.from({ length: start.count }, (_, i) => Math.hypot(start.getX(i), start.getY(i), start.getZ(i)));
    });
    const dir = radii.slice(1).map((r, i) => r - radii[i]!).filter((d) => Math.abs(d) > 1e-6);
    expect(dir.slice(1).filter((d, i) => Math.sign(d) !== Math.sign(dir[i]!))).toHaveLength(1);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(1 - 1e-6);
  });

  const radiiOf = (parent: Group): number[][] =>
    parent.children.filter((c): c is LineSegments2 => "isLineSegments2" in c).map((l) => {
      const start = l.geometry.getAttribute("instanceStart");
      return Array.from({ length: start.count }, (_, i) => Math.hypot(start.getX(i), start.getY(i), start.getZ(i)));
    });

  it("keeps a run's hump continuous when its trailing nodes are stacked on the near anchor and a far anchor arrives", () => {
    // Hops 2 and 3 have not spread yet: they sit on hop 1. The ttl fractions of their arcs still say 1/3 and 2/3.
    const parent = new Group();
    const arcs = createArcs(parent, () => new Texture());
    const a = latLonToVec3(40, -74), b = latLonToVec3(51, 0);
    const at = (pos: Pose["pos"]): Pose => ({ pos, scale: 1, opacity: 1 });
    const poses = new Map([[1, at(a)], [2, at(a)], [3, at(a)], [4, at(b)]]);
    const infos: ArcInfo[] = [1, 2, 3].map((from) => ({
      from, to: from + 1, colorFrom: "#ffffff", colorTo: "#22e6ff", estimated: true,
          }));
    arcs.update(shaped(poses, [1, 4]), infos, 0, true, 1);
    // The arc into hop 4 starts on the near anchor, so it starts on the surface: no spike at its stacked end.
    const last = radiiOf(parent).at(-1)!;
    expect(last[0]).toBeCloseTo(1, 3);
    expect(Math.max(...last)).toBeGreaterThan(1.01); // and still rises into the hump
  });
});
