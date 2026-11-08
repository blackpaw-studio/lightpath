import { describe, expect, it } from "vitest";
import { Group, Sprite, Texture } from "three";
import { latLonToVec3 } from "../geo";
import { createArcs, type ArcInfo } from "./arcs";
import type { Pose } from "./globePoses";

const pose = (lat: number, lon: number): Pose => ({ pos: latLonToVec3(lat, lon), scale: 1, opacity: 1 });
const arc: ArcInfo = { from: 0, to: 1, colorFrom: "#ffffff", colorTo: "#22e6ff", estimated: false };
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
});
