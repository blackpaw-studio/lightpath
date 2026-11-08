import {
  AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, Sprite, SpriteMaterial,
  Vector3, type Object3D,
} from "three";
import type { Pose, PoseMap } from "./globePoses";
import { glowTexture } from "./glow";

export type NodeRole = "origin" | "hop" | "destination";

export interface NodeInfo {
  readonly color: string;
  readonly estimated: boolean;
  readonly timeout: boolean;
  readonly role: NodeRole;
}

export interface Nodes {
  /** Positions/scale/opacity come only from `poses`; `info` supplies look. */
  update(poses: PoseMap, info: ReadonlyMap<number, NodeInfo>, nowMs: number, reducedMotion: boolean): void;
  dispose(): void;
}

const NODE_SIZE = 0.1;
const RIPPLE_MS = 1500;
const ORIGIN_COLOR = "#e8fbff";
const Z = new Vector3(0, 0, 1);

interface Entry {
  readonly group: Group;
  readonly glow: Sprite;
  readonly ring: Mesh;
  readonly bornAt: number;
  readonly seed: number;
}

/** 0..1 smooth pseudo-noise from summed incommensurate sines. */
const shimmer = (t: number, seed: number): number =>
  0.5 + 0.25 * Math.sin(t * 7.3 + seed * 3.1) + 0.25 * Math.sin(t * 12.9 + seed * 7.7);

const ringGeometry = new RingGeometry(0.88, 1, 64);

const makeEntry = (key: number, nowMs: number): Entry => {
  const glow = new Sprite(new SpriteMaterial({
    map: glowTexture(), blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
  }));
  const ring = new Mesh(ringGeometry, new MeshBasicMaterial({
    blending: AdditiveBlending, depthWrite: false, transparent: true, side: DoubleSide, toneMapped: false,
  }));
  const group = new Group();
  group.add(ring, glow);
  group.renderOrder = 3;
  return { group, glow, ring, bornAt: nowMs, seed: (key * 0.618034) % 1 };
};

const disposeEntry = (e: Entry): void => {
  (e.glow.material as SpriteMaterial).dispose();
  (e.ring.material as MeshBasicMaterial).dispose();
};

export const createNodes = (parent: Object3D): Nodes => {
  const entries = new Map<number, Entry>();
  const tmpColor = new Color();
  const normal = new Vector3();
  const q = new Quaternion();

  const updateEntry = (e: Entry, pose: Pose, info: NodeInfo, nowMs: number, reducedMotion: boolean): void => {
    const t = nowMs / 1000;
    const [x, y, z] = pose.pos;
    e.group.position.set(x, y, z);
    normal.set(x, y, z).normalize();
    q.setFromUnitVectors(Z, normal);
    e.ring.quaternion.copy(q);

    const special = info.role !== "hop";
    const base = info.role === "origin" ? ORIGIN_COLOR : info.color;
    const flicker = info.estimated && !reducedMotion ? shimmer(t, e.seed) : 1;
    // Estimated nodes shimmer but never drop below 60 % opacity.
    const alpha = pose.opacity * (info.estimated ? 0.6 + 0.4 * flicker : 1) * (info.timeout ? 0.55 : 1);
    const intensity = info.timeout ? 0.8 : special ? 2.8 : 2.4;

    // In the tunnel the hop is drawn as its gate ring: the dot shrinks away as it morphs.
    const dot = 1 - (pose.morph ?? 0);
    const size = NODE_SIZE * pose.scale * dot * (special ? 1.35 : 1) * (info.timeout ? 0.7 : 1);
    e.glow.scale.setScalar(Math.max(size, 1e-5));
    const gm = e.glow.material as SpriteMaterial;
    gm.color.copy(tmpColor.set(base)).multiplyScalar(intensity);
    gm.opacity = alpha;

    // Breathing beacon for origin/destination, a static faint ring for timeout-only
    // hops, and a one-shot arrival ripple for everything else.
    const age = nowMs - e.bornAt;
    const rm = e.ring.material as MeshBasicMaterial;
    rm.color.set(base);
    if (special) {
      const breath = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2);
      e.ring.scale.setScalar(0.022 + 0.008 * breath);
      rm.opacity = pose.opacity * (0.35 + 0.35 * breath);
    } else if (info.timeout) {
      e.ring.scale.setScalar(0.016 * pose.scale);
      rm.opacity = pose.opacity * 0.45;
    } else if (!reducedMotion && age < RIPPLE_MS) {
      const k = age / RIPPLE_MS;
      e.ring.scale.setScalar(0.01 + 0.05 * (1 - (1 - k) ** 3));
      rm.opacity = pose.opacity * 0.9 * (1 - k) ** 2;
    } else {
      rm.opacity = 0;
    }
    rm.opacity *= dot;
    e.ring.visible = rm.opacity > 0.001;
    e.glow.visible = size > 1e-4;
  };

  return {
    update: (poses, info, nowMs, reducedMotion) => {
      for (const [k, e] of entries) {
        if (!poses.has(k)) {
          parent.remove(e.group);
          disposeEntry(e);
          entries.delete(k);
        }
      }
      for (const [k, pose] of poses) {
        const look = info.get(k);
        if (!look) continue;
        let e = entries.get(k);
        if (!e) {
          e = makeEntry(k, nowMs);
          entries.set(k, e);
          parent.add(e.group);
        }
        updateEntry(e, pose, look, nowMs, reducedMotion);
      }
    },
    dispose: () => {
      entries.forEach((e) => { parent.remove(e.group); disposeEntry(e); });
      entries.clear();
    },
  };
};
