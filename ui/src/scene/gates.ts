// A ring gate per hop (and the mouth ring for the origin). Every gate and its
// label sits at the hop's pose: the dot of the globe view opens into the ring
// as pose.morph goes 0 → 1. Timeout-only hops get a dim ring broken into arcs.
import {
  AdditiveBlending, Color, Group, Matrix4, Mesh, MeshBasicMaterial, Quaternion, ShaderMaterial, TorusGeometry, Vector3,
  type Object3D,
} from "three";
import { NO_RTT_COLOR } from "../color";
import { smoothstep } from "./easing";
import { ORIGIN_KEY, type Pose, type PoseMap } from "./globePoses";
import { tunnelTangent, type TunnelFrame, type TunnelGate } from "./tunnelLayout";
import { TUBE_R } from "./tunnel";
import { createGateLabel, type GateLabelView } from "./labels";

export const GATE_R = 0.2;
const MOUTH_R = TUBE_R * 0.94;
const MOUTH_COLOR = "#e8fbff";
/** Core brightness: just under the tunnel bloom threshold, so glow comes from the halo, not full-frame bloom haze. */
const RING_GAIN = 1.1;
/** Soft halo around each live ring (in place of bloom inside the tube). */
const HALO_GAIN = 0.45;
const BROKEN_DIM = 0.3;
const BROKEN_ARCS = 6;
const BROKEN_FILL = 0.62;
const RETICLE_ARCS = 3;
const RETICLE_FILL = 0.7;
/** Label anchor offsets from the gate centre in (u, v), in ring radii. */
const LABEL_BESIDE: readonly [number, number] = [1.05, 0.55];
const LABEL_ABOVE: readonly [number, number] = [0.3, 1.1];
/** World size of the dot a ring starts from before it opens. */
const DOT_FRACTION = 0.14;

const ringGeometry = new TorusGeometry(1, 0.022, 12, 192);
const brokenGeometry = new TorusGeometry(1, 0.02, 8, 40, ((2 * Math.PI) / BROKEN_ARCS) * BROKEN_FILL);
const reticleGeometry = new TorusGeometry(1, 0.011, 6, 64, ((2 * Math.PI) / RETICLE_ARCS) * RETICLE_FILL);
const haloGeometry = new TorusGeometry(1, 0.12, 16, 192);

/** Brightest where the halo tube faces the camera, fading to nothing at its silhouette. */
const haloVertex = /* glsl */ `
  varying float vFacing;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;
const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFacing;
  void main() {
    gl_FragColor = vec4(uColor * pow(vFacing, 4.0) * uOpacity, 1.0);
  }
`;
const haloMaterial = (): ShaderMaterial =>
  new ShaderMaterial({
    vertexShader: haloVertex, fragmentShader: haloFragment, transparent: true, depthWrite: false,
    blending: AdditiveBlending, uniforms: { uColor: { value: new Color() }, uOpacity: { value: 0 } },
  });

export interface GateFrameInput {
  readonly poses: PoseMap;
  readonly gates: readonly TunnelGate[];
  readonly depths: ReadonlyMap<number, number>;
  readonly frame: TunnelFrame | null;
  readonly cameraPos: Vec3Like;
  /** Trace generation (TraceState.generation): a new trace rebuilds every hop's gate and label. */
  readonly generation: number;
  /** Ring opacity (plan: 0.4 → 0.8 of viewT). */
  readonly ringFade: number;
  /** Label opacity (plan: 0.8 → 1 of viewT). */
  readonly labelFade: number;
  readonly nowMs: number;
  readonly reducedMotion: boolean;
  /** Viewport width / height: portrait screens are narrower than a near ring, so labels go above it. */
  readonly aspect: number;
}

type Vec3Like = readonly [number, number, number];

export interface Gates {
  update(input: GateFrameInput): void;
  dispose(): void;
}

interface Entry {
  readonly group: Group;
  readonly rings: readonly Mesh[];
  readonly reticle: Group;
  readonly material: MeshBasicMaterial;
  readonly reticleMaterial: MeshBasicMaterial;
  readonly halo: ShaderMaterial | null;
  readonly label: GateLabelView | null;
  readonly broken: boolean;
  readonly generation: number;
}

const additive = (): MeshBasicMaterial =>
  new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false });

const arcRing = (geometry: TorusGeometry, material: MeshBasicMaterial, count: number, phase: number): Mesh[] =>
  Array.from({ length: count }, (_, i) => {
    const m = new Mesh(geometry, material);
    m.rotation.z = phase + (i * 2 * Math.PI) / count;
    return m;
  });

const makeEntry = (key: number, broken: boolean, generation: number, parent: Object3D): Entry => {
  const material = additive();
  const reticleMaterial = additive();
  const rings = broken ? arcRing(brokenGeometry, material, BROKEN_ARCS, key * 0.37) : [new Mesh(ringGeometry, material)];
  const reticle = new Group();
  reticle.add(...arcRing(reticleGeometry, reticleMaterial, RETICLE_ARCS, key * 0.9));
  const halo = broken ? null : haloMaterial();
  const group = new Group();
  group.add(...rings, reticle, ...(halo ? [new Mesh(haloGeometry, halo)] : []));
  group.renderOrder = 3;
  parent.add(group);
  const label = key === ORIGIN_KEY ? null : createGateLabel();
  if (label) parent.add(label.object);
  return { group, rings, reticle, material, reticleMaterial, halo, label, broken, generation };
};

const disposeEntry = (e: Entry, parent: Object3D): void => {
  parent.remove(e.group);
  if (e.label) {
    parent.remove(e.label.object);
    e.label.dispose();
  }
  e.material.dispose();
  e.reticleMaterial.dispose();
  e.halo?.dispose();
};

/** Distance fog for rings (the tube shader fogs the same way). */
const fog = (d: number): number => Math.exp(-d * 0.2) * smoothstep(0.02, 0.18, d);
/** Labels only for the nearest few gates, so the vanishing point never piles up text. */
const labelRange = (d: number): number => smoothstep(2.6, 1.6, d) * smoothstep(0.15, 0.45, d);

export const createGates = (parent: Object3D): Gates => {
  const entries = new Map<number, Entry>();
  const color = new Color();
  const q = new Quaternion();
  const m = new Matrix4();
  const tangent = new Vector3();
  const up = new Vector3();
  const zero = new Vector3();

  const orient = (e: Entry, frame: TunnelFrame | null, s: number): void => {
    if (!frame) return;
    tangent.set(...tunnelTangent(frame, s));
    up.set(...frame.v);
    q.setFromRotationMatrix(m.lookAt(zero, tangent, up));
    e.group.quaternion.copy(q);
  };

  const placeLabel = (e: Entry, pose: Pose, frame: TunnelFrame | null, aspect: number, side: number): void => {
    if (!e.label || !frame) return;
    // Beside the ring (landscape) or over its top (portrait, where a near ring
    // overflows the screen's width), right or left alternating by ttl so
    // neighbours never collide.
    const [du, dv] = aspect >= 1 ? LABEL_BESIDE : LABEL_ABOVE;
    const o = (k: number): number => pose.pos[k]! + (frame.u[k]! * side * du + frame.v[k]! * dv) * GATE_R;
    e.label.object.position.set(o(0), o(1), o(2));
    e.label.setSide(side > 0 ? "right" : "left");
  };

  const updateEntry = (key: number, e: Entry, pose: Pose, gate: TunnelGate | undefined, input: GateFrameInput): void => {
    const s = input.depths.get(key) ?? 0;
    const isMouth = key === ORIGIN_KEY;
    const morph = pose.morph ?? 0;
    const radius = (isMouth ? MOUTH_R : GATE_R) * pose.scale * (DOT_FRACTION + (1 - DOT_FRACTION) * morph);
    const d = Math.hypot(pose.pos[0] - input.cameraPos[0], pose.pos[1] - input.cameraPos[1], pose.pos[2] - input.cameraPos[2]);
    const dim = e.broken ? BROKEN_DIM : 1;
    const alpha = pose.opacity * input.ringFade * fog(d);

    e.group.position.set(...pose.pos);
    e.group.scale.setScalar(Math.max(radius, 1e-5));
    e.group.visible = alpha > 0.001;
    orient(e, input.frame, s);

    const hex = isMouth ? MOUTH_COLOR : e.broken ? NO_RTT_COLOR : (gate?.color ?? NO_RTT_COLOR);
    e.material.color.copy(color.set(hex)).multiplyScalar(RING_GAIN * dim);
    e.material.opacity = alpha;
    e.reticleMaterial.color.copy(e.material.color).multiplyScalar(0.55);
    e.reticleMaterial.opacity = alpha * (e.broken ? 0 : 1);
    if (e.halo) {
      (e.halo.uniforms.uColor!.value as Color).set(hex).multiplyScalar(HALO_GAIN);
      e.halo.uniforms.uOpacity!.value = alpha;
    }
    e.reticle.scale.setScalar(0.84);
    e.reticle.rotation.z = input.reducedMotion ? 0 : (input.nowMs / 1000) * 0.35 * (key % 2 === 0 ? 1 : -1);

    if (e.label && gate) {
      const side = key % 2 === 0 ? 1 : -1;
      placeLabel(e, pose, input.frame, input.aspect, side);
      e.label.set(gate, hex);
      e.label.setOpacity(pose.opacity * input.labelFade * labelRange(d));
    }
  };

  return {
    update: (input) => {
      const byTtl = new Map(input.gates.map((g) => [g.ttl, g] as const));
      for (const [k, e] of entries) {
        const gate = byTtl.get(k);
        const gone = !input.poses.has(k) || (k !== ORIGIN_KEY && !gate);
        const stale = k !== ORIGIN_KEY && e.generation !== input.generation;
        if (gone || stale || (gate && gate.broken !== e.broken)) {
          disposeEntry(e, parent);
          entries.delete(k);
        }
      }
      for (const [k, pose] of input.poses) {
        const gate = byTtl.get(k);
        if (k !== ORIGIN_KEY && !gate) continue;
        let e = entries.get(k);
        if (!e) {
          e = makeEntry(k, gate?.broken ?? false, input.generation, parent);
          entries.set(k, e);
        }
        updateEntry(k, e, pose, gate, input);
      }
    },
    dispose: () => {
      entries.forEach((e) => disposeEntry(e, parent));
      entries.clear();
    },
  };
};
