import {
  AdditiveBlending, Color, InstancedInterleavedBuffer, InterleavedBufferAttribute, Sprite, SpriteMaterial, type Object3D,
  type Texture,
} from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../geo";
import { writeArcPoints, type ArcSpan } from "./arcGeometry";
import type { PoseMap } from "./globePoses";
import { glowTexture } from "./glow";
import type { DrawnMark } from "./marks";
import { PULSE_MS, pulseHead, pulseIntensity } from "./pulse";

/** An arc from hop `from` to hop `to` (keys into the PoseMap). */
export interface ArcInfo {
  readonly from: number;
  readonly to: number;
  readonly colorFrom: string;
  readonly colorTo: string;
  /** Either end is estimated → dashed. */
  readonly estimated: boolean;
  /** Set when this arc is a piece of a run of estimated hops between two located anchors (see arcInfos). */
  readonly span?: ArcRun;
}

/** The run an arc belongs to: the pose keys of its two located anchors. */
export interface ArcRun {
  readonly from: number;
  readonly to: number;
}

export interface Arcs {
  /** Endpoints come only from `poses`; arcs are keyed by `to` within a trace `generation`. */
  update(poses: PoseMap, arcs: readonly ArcInfo[], nowMs: number, reducedMotion: boolean, generation: number): void;
  setResolution(width: number, height: number, pixelRatio: number): void;
  /** The highest point of each drawn arc this frame, keyed by the ttl it ends at (trace entities). */
  apexes(): ReadonlyMap<number, DrawnMark>;
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
  readonly to: number;
  readonly seed: number;
  /** Highest point as last drawn; null while the arc is hidden. */
  apex: DrawnMark | null;
  estimated: boolean;
  /** Parsed endpoint colours, re-parsed only when the hex strings change. */
  readonly colorFrom: Color;
  readonly colorTo: Color;
  colorKey: string;
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
  return { line, material, pos, col, dist, posBuf, colBuf, distBuf, head, bornAt: nowMs, to, apex: null, seed: (to * 0.381966) % 1, estimated,
    colorFrom: new Color(), colorTo: new Color(), colorKey: "" };
};

/** Angle between two (not necessarily unit) vectors, without allocating. */
const angleBetween = (a: Vec3, b: Vec3): number => {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};

const MIN_RUN_ANGLE = 1e-4;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * The arc's extent along its run, from where its endpoints are drawn this frame: their angle from the
 * near anchor over the anchors' full angle. Nodes stacked on an anchor get s0 = s1 (a flat arc) and the
 * hump grows smoothly as they spread, instead of jumping with the run's membership.
 */
const spanOf = (run: ArcRun | undefined, info: ArcInfo, poses: PoseMap): ArcSpan | undefined => {
  const a = run && poses.get(run.from);
  const b = run && poses.get(run.to);
  const p0 = poses.get(info.from);
  const p1 = poses.get(info.to);
  if (!run || !a || !b || !p0 || !p1) return undefined;
  const theta = angleBetween(a.pos, b.pos);
  if (theta < MIN_RUN_ANGLE) return undefined;
  return { t0: clamp01(angleBetween(a.pos, p0.pos) / theta), t1: clamp01(angleBetween(a.pos, p1.pos) / theta), theta };
};

export const createArcs = (parent: Object3D, texture: () => Texture = glowTexture): Arcs => {
  const entries = new Map<string, Entry>();
  // Scratch shared by every arc (fill runs synchronously, one arc at a time).
  const pts = new Float32Array((SEGMENTS + 1) * 3);
  const rgb = new Float32Array((SEGMENTS + 1) * 3);
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

  const fill = (e: Entry, a: Vec3, b: Vec3, info: ArcInfo, poses: PoseMap, nowMs: number, reducedMotion: boolean, alpha: number): void => {
    const key = info.colorFrom + info.colorTo;
    if (key !== e.colorKey) {
      e.colorFrom.set(info.colorFrom);
      e.colorTo.set(info.colorTo);
      e.colorKey = key;
    }
    const { colorFrom: cf, colorTo: ct } = e;
    const age = nowMs - e.bornAt;
    const opts = { reducedMotion, estimated: info.estimated, seed: e.seed };
    const gain = alpha * ARC_GAIN;
    writeArcPoints(pts, a, b, SEGMENTS, undefined, spanOf(info.span, info, poses));
    // Per-vertex colour = endpoint gradient × pulse brightness, computed once per vertex.
    for (let v = 0; v <= SEGMENTS; v++) {
      const u = v / SEGMENTS;
      const k = pulseIntensity(u, age, nowMs, opts) * gain;
      rgb[v * 3] = (cf.r + (ct.r - cf.r) * u) * k;
      rgb[v * 3 + 1] = (cf.g + (ct.g - cf.g) * u) * k;
      rgb[v * 3 + 2] = (cf.b + (ct.b - cf.b) * u) * k;
    }
    let acc = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const s0 = i * 3;
      const s1 = s0 + 3;
      const o = i * 6;
      e.pos[o] = pts[s0]!; e.pos[o + 1] = pts[s0 + 1]!; e.pos[o + 2] = pts[s0 + 2]!;
      e.pos[o + 3] = pts[s1]!; e.pos[o + 4] = pts[s1 + 1]!; e.pos[o + 5] = pts[s1 + 2]!;
      e.col[o] = rgb[s0]!; e.col[o + 1] = rgb[s0 + 1]!; e.col[o + 2] = rgb[s0 + 2]!;
      e.col[o + 3] = rgb[s1]!; e.col[o + 4] = rgb[s1 + 1]!; e.col[o + 5] = rgb[s1 + 2]!;
      e.dist[i * 2] = acc;
      acc += Math.hypot(pts[s1]! - pts[s0]!, pts[s1 + 1]! - pts[s0 + 1]!, pts[s1 + 2]! - pts[s0 + 2]!);
      e.dist[i * 2 + 1] = acc;
    }
    let top = 0;
    for (let v = 1; v <= SEGMENTS; v++) {
      if (Math.hypot(pts[v * 3]!, pts[v * 3 + 1]!, pts[v * 3 + 2]!) > Math.hypot(pts[top * 3]!, pts[top * 3 + 1]!, pts[top * 3 + 2]!)) top = v;
    }
    e.apex = { pos: [pts[top * 3]!, pts[top * 3 + 1]!, pts[top * 3 + 2]!], alpha };
    e.posBuf.needsUpdate = true;
    e.colBuf.needsUpdate = true;
    e.distBuf.needsUpdate = true;

    const travelling = !reducedMotion && age < PULSE_MS;
    e.head.visible = travelling;
    if (travelling) {
      const h = pulseHead(age);
      const idx = Math.min(Math.round(h * SEGMENTS), SEGMENTS) * 3;
      e.head.position.set(pts[idx]!, pts[idx + 1]!, pts[idx + 2]!);
      e.head.scale.setScalar(HEAD_SIZE);
      const hm = e.head.material as SpriteMaterial;
      hm.color.copy(cf).lerp(ct, h).multiplyScalar(3);
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
        const degenerate = !a || !b || angleBetween(a.pos, b.pos) < MIN_ANGLE;
        e.line.visible = !degenerate;
        if (degenerate) {
          e.head.visible = false;
          e.apex = null;
          continue;
        }
        fill(e, a.pos, b.pos, info, poses, nowMs, reducedMotion, Math.min(a.opacity, b.opacity) * globalOpacity);
      }
    },
    setResolution: (w, h, dpr) => {
      resolution = { w, h, dpr };
      entries.forEach(applyResolution);
    },
    apexes: () => new Map([...entries.values()].flatMap((e) => (e.apex && e.line.visible ? [[e.to, e.apex] as const] : []))),
    setOpacity: (o) => { globalOpacity = o; },
    dispose: () => entries.forEach((e, k) => remove(k, e)),
  };
};
