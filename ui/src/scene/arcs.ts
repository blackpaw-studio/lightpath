import {
  AdditiveBlending, Color, InstancedInterleavedBuffer, InterleavedBufferAttribute, Sprite, SpriteMaterial, type Object3D,
  type Texture,
} from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { angularDistance, arcPoints, type Vec3 } from "../geo";
import type { PoseMap } from "./globePoses";
import { glowTexture } from "./glow";
import { PULSE_MS, pulseHead, pulseIntensity } from "./pulse";

/** An arc from hop `from` to hop `to` (keys into the PoseMap). */
export interface ArcInfo {
  readonly from: number;
  readonly to: number;
  readonly colorFrom: string;
  readonly colorTo: string;
  /** Either end is estimated → dashed. */
  readonly estimated: boolean;
}

export interface Arcs {
  /** Endpoints come only from `poses`; arcs are keyed by `to` within a trace `generation`. */
  update(poses: PoseMap, arcs: readonly ArcInfo[], nowMs: number, reducedMotion: boolean, generation: number): void;
  setResolution(width: number, height: number, pixelRatio: number): void;
  /** Global fade (the tunnel lane fades globe arcs out). */
  setOpacity(o: number): void;
  dispose(): void;
}

const SEGMENTS = 64;
const MIN_ANGLE = 1e-4;
const LINE_WIDTH_PX = 2.2;
const HEAD_SIZE = 0.07;
/** Linear-light gain so resting arcs sit near the bloom threshold. */
const ARC_GAIN = 1.7;

interface Entry {
  readonly line: LineSegments2;
  readonly material: LineMaterial;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly dist: Float32Array;
  readonly posBuf: InstancedInterleavedBuffer;
  readonly colBuf: InstancedInterleavedBuffer;
  readonly distBuf: InstancedInterleavedBuffer;
  readonly head: Sprite;
  readonly bornAt: number;
  readonly seed: number;
  estimated: boolean;
}

const makeEntry = (to: number, nowMs: number, estimated: boolean, texture: Texture): Entry => {
  const geometry = new LineSegmentsGeometry();
  const pos = new Float32Array(SEGMENTS * 6);
  const col = new Float32Array(SEGMENTS * 6);
  const dist = new Float32Array(SEGMENTS * 2);
  const posBuf = new InstancedInterleavedBuffer(pos, 6, 1);
  const colBuf = new InstancedInterleavedBuffer(col, 6, 1);
  const distBuf = new InstancedInterleavedBuffer(dist, 2, 1);
  geometry.setAttribute("instanceStart", new InterleavedBufferAttribute(posBuf, 3, 0));
  geometry.setAttribute("instanceEnd", new InterleavedBufferAttribute(posBuf, 3, 3));
  geometry.setAttribute("instanceColorStart", new InterleavedBufferAttribute(colBuf, 3, 0));
  geometry.setAttribute("instanceColorEnd", new InterleavedBufferAttribute(colBuf, 3, 3));
  geometry.setAttribute("instanceDistanceStart", new InterleavedBufferAttribute(distBuf, 1, 0));
  geometry.setAttribute("instanceDistanceEnd", new InterleavedBufferAttribute(distBuf, 1, 1));
  geometry.instanceCount = SEGMENTS;
  const material = new LineMaterial({
    linewidth: LINE_WIDTH_PX, vertexColors: true, transparent: true, depthWrite: false,
    blending: AdditiveBlending, dashed: estimated, dashSize: 0.018, gapSize: 0.014, toneMapped: false,
  });
  const line = new LineSegments2(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = 2;
  const head = new Sprite(new SpriteMaterial({
    map: texture, blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
  }));
  head.renderOrder = 4;
  return { line, material, pos, col, dist, posBuf, colBuf, distBuf, head, bornAt: nowMs, seed: (to * 0.381966) % 1, estimated };
};

const len = (v: Vec3): number => Math.hypot(...v);
const unit = (v: Vec3): Vec3 => {
  const l = len(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Arc between two poses: great circle with altitude ∝ angle, radius blended between the endpoints. */
const curve = (a: Vec3, b: Vec3): Vec3[] => {
  const ra = len(a);
  const rb = len(b);
  return arcPoints(unit(a), unit(b), SEGMENTS).map((p, i) => {
    const r = ra + ((rb - ra) * i) / SEGMENTS;
    return [p[0] * r, p[1] * r, p[2] * r];
  });
};

export const createArcs = (parent: Object3D, texture: () => Texture = glowTexture): Arcs => {
  const entries = new Map<string, Entry>();
  const cFrom = new Color();
  const cTo = new Color();
  const c = new Color();
  let globalOpacity = 1;
  let resolution = { w: 1, h: 1, dpr: 1 };

  const applyResolution = (e: Entry): void => {
    e.material.resolution.set(resolution.w * resolution.dpr, resolution.h * resolution.dpr);
    e.material.linewidth = LINE_WIDTH_PX * resolution.dpr;
  };

  const remove = (k: string, e: Entry): void => {
    parent.remove(e.line, e.head);
    e.line.geometry.dispose();
    e.material.dispose();
    (e.head.material as SpriteMaterial).dispose();
    entries.delete(k);
  };

  const fill = (e: Entry, pts: Vec3[], info: ArcInfo, nowMs: number, reducedMotion: boolean, alpha: number): void => {
    cFrom.set(info.colorFrom);
    cTo.set(info.colorTo);
    const age = nowMs - e.bornAt;
    const opts = { reducedMotion, estimated: info.estimated, seed: e.seed };
    let acc = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      e.pos.set(p0, i * 6);
      e.pos.set(p1, i * 6 + 3);
      e.dist[i * 2] = acc;
      acc += Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      e.dist[i * 2 + 1] = acc;
      for (const [j, u] of [[0, i / SEGMENTS], [3, (i + 1) / SEGMENTS]] as const) {
        const k = pulseIntensity(u, age, nowMs, opts) * alpha * ARC_GAIN;
        c.copy(cFrom).lerp(cTo, u).multiplyScalar(k);
        e.col[i * 6 + j] = c.r;
        e.col[i * 6 + j + 1] = c.g;
        e.col[i * 6 + j + 2] = c.b;
      }
    }
    e.posBuf.needsUpdate = true;
    e.colBuf.needsUpdate = true;
    e.distBuf.needsUpdate = true;

    const travelling = !reducedMotion && age < PULSE_MS;
    e.head.visible = travelling;
    if (travelling) {
      const h = pulseHead(age);
      const idx = Math.min(Math.round(h * SEGMENTS), SEGMENTS);
      e.head.position.set(...pts[idx]!);
      e.head.scale.setScalar(HEAD_SIZE);
      const hm = e.head.material as SpriteMaterial;
      hm.color.copy(cFrom).lerp(cTo, h).multiplyScalar(3);
      hm.opacity = alpha;
    }
  };

  return {
    update: (poses, arcs, nowMs, reducedMotion, generation) => {
      const keyOf = (to: number): string => `${generation}:${to}`;
      const wanted = new Set(arcs.map((a) => keyOf(a.to)));
      for (const [k, e] of entries) if (!wanted.has(k)) remove(k, e);
      for (const info of arcs) {
        const a = poses.get(info.from);
        const b = poses.get(info.to);
        let e = entries.get(keyOf(info.to));
        if (!e) {
          e = makeEntry(info.to, nowMs, info.estimated, texture());
          applyResolution(e);
          entries.set(keyOf(info.to), e);
          parent.add(e.line, e.head);
        }
        if (e.estimated !== info.estimated) {
          e.estimated = info.estimated;
          e.material.dashed = info.estimated;
          e.material.needsUpdate = true;
        }
        const degenerate = !a || !b || angularDistance(unit(a.pos), unit(b.pos)) < MIN_ANGLE;
        e.line.visible = !degenerate;
        if (degenerate) {
          e.head.visible = false;
          continue;
        }
        fill(e, curve(a.pos, b.pos), info, nowMs, reducedMotion, Math.min(a.opacity, b.opacity) * globalOpacity);
      }
    },
    setResolution: (w, h, dpr) => {
      resolution = { w, h, dpr };
      entries.forEach(applyResolution);
    },
    setOpacity: (o) => { globalOpacity = o; },
    dispose: () => entries.forEach((e, k) => remove(k, e)),
  };
};
