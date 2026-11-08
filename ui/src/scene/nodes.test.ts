import { describe, expect, it } from "vitest";
import { Group, Mesh, Texture } from "three";
import { latLonToVec3 } from "../geo";
import type { Pose } from "./globePoses";
import { createNodes, type NodeInfo } from "./nodes";

const pose = (lat: number, lon: number): Pose => ({ pos: latLonToVec3(lat, lon), scale: 1, opacity: 1 });
const info = new Map<number, NodeInfo>([
  [0, { color: "#ffffff", estimated: false, timeout: false, role: "origin" }],
  [1, { color: "#22e6ff", estimated: false, timeout: false, role: "hop" }],
]);
const ringOf = (parent: Group, at: readonly number[]): Mesh => {
  const g = parent.children.find((c) => c.position.toArray().every((x, i) => Math.abs(x - at[i]!) < 1e-9))!;
  return g.children.find((c): c is Mesh => c instanceof Mesh)!;
};

describe("createNodes", () => {
  it("restarts a hop's arrival ripple when a new trace reuses its ttl", () => {
    const parent = new Group();
    const nodes = createNodes(parent, () => new Texture());
    const a = new Map([[0, pose(40, -74)], [1, pose(41, -73)]]);
    nodes.update(a, info, 0, false, 1);
    nodes.update(a, info, 5000, false, 1);
    expect(ringOf(parent, a.get(1)!.pos).visible).toBe(false); // ripple finished

    const b = new Map([[0, pose(40, -74)], [1, pose(51, 0)]]);
    nodes.update(b, info, 5016, false, 2);
    expect(parent.children).toHaveLength(2);
    expect(ringOf(parent, b.get(1)!.pos).visible).toBe(true);
  });
});
