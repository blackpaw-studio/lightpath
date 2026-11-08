// The neon tube: a TubeGeometry along the helix (built in the tunnel's local
// frame), shaded with flowing ring lines, longitudinal lanes and light packets
// racing toward the destination, tinted by RTT along its length and fogged.
import {
  AdditiveBlending, BackSide, CircleGeometry, ClampToEdgeWrapping, Curve, DataTexture, DoubleSide, Group, LinearFilter,
  Matrix4, Mesh, Quaternion, RGBAFormat, ShaderMaterial, SRGBColorSpace, TubeGeometry, Vector3,
} from "three";
import type { Vec3 } from "../geo";
import { helixLocal, type TunnelFrame, type TunnelGate } from "./tunnelLayout";

export const TUBE_R = 0.34;
/** Tube length past the last gate, and the step the built length grows by. */
const TAIL = 3;
const LENGTH_STEP = 4;
const SEGMENTS_PER_UNIT = 28;
const RADIAL_SEGMENTS = 64;
export const RAMP_SIZE = 256;
const MOUTH_COLOR = "#bff6ff";

class HelixCurve extends Curve<Vector3> {
  constructor(private readonly length: number) {
    super();
  }
  override getPoint(t: number, target = new Vector3()): Vector3 {
    return target.set(...helixLocal(t * this.length));
  }
}

/** Cap overlap past the wall, so the 64-gon cap leaves no sliver against the 64-gon tube. */
const CAP_OVERSIZE = 1.02;

/**
 * Disc closing the tube's far end (tunnel-local frame). The tube is open-ended,
 * and without this the screen-space backdrop's bright core shows through the
 * end as a hard-edged disc at the vanishing point. UV u = 1 so the fill
 * samples the tail's tint.
 */
export const endCapGeometry = (length: number): CircleGeometry => {
  const curve = new HelixCurve(length);
  const geometry = new CircleGeometry(TUBE_R * CAP_OVERSIZE, RADIAL_SEGMENTS);
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 1, 0.5);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), curve.getTangent(1)));
  geometry.translate(...helixLocal(length));
  return geometry;
};

const vertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uLength;
  uniform float uMotion;
  uniform sampler2D uRamp;
  varying vec2 vUv;
  varying vec3 vWorld;

  const float LANES = 18.0;
  const float RING_GAP = 0.45;

  float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  // Anti-aliased line of half-width w (in pixels) at integer values of x,
  // faded out where lines crowd closer than a few pixels (the vanishing point)
  // so they never sum into a solid disc.
  float grid(float x, float w) {
    float fw = max(fwidth(x), 1e-4);
    float d = abs(fract(x - 0.5) - 0.5) / fw;
    return (1.0 - smoothstep(w, w + 1.0, d)) * (1.0 - smoothstep(0.15, 0.4, fw));
  }

  void main() {
    float s = vUv.x * uLength;
    vec3 base = texture2D(uRamp, vec2(vUv.x, 0.5)).rgb;
    float dist = length(vWorld - cameraPosition);
    float fog = exp(-dist * 0.28);
    float near = smoothstep(0.08, 0.7, dist);

    float flow = uTime * uMotion;
    float rings = grid(s / RING_GAP - flow * 1.6, 0.6);
    float lane = vUv.y * LANES;
    float lanes = grid(lane, 0.45);

    // Light packets: one per lane, each racing down the tunnel at its own speed.
    float id = floor(lane + 0.5);
    float speed = 1.4 + 2.2 * hash(id + 3.0);
    float period = 5.0 + 6.0 * hash(id + 11.0);
    float head = fract((s - flow * speed) / period + hash(id));
    float packet = exp(-head * period * 3.2) * smoothstep(0.0, 0.004, head) * grid(lane, 1.2);

    // Faint wall so the tube reads as a volume, brighter at grazing angles far down it.
    // Linear light: sRGB output lifts 0.01 to ~25/255, so keep this tiny.
    float wall = 0.002 + 0.008 * smoothstep(0.3, 3.0, dist);
  #ifdef END_CAP
    // The far cap carries only the wall's faint glow: no grid lines on a flat disc.
    float light = wall;
  #else
    float light = wall + rings * 0.4 + lanes * 0.18 + packet * 1.8 * uMotion + lanes * 0.08 * (1.0 - uMotion);
  #endif
    gl_FragColor = vec4(base * light * fog * near * uOpacity, 1.0);
  }
`;

/** Dark inner wall drawn under the glow: hides the starfield so the tube reads as a solid passage. */
const fillFragment = /* glsl */ `
  uniform float uOpacity;
  uniform sampler2D uRamp;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    float dist = length(vWorld - cameraPosition);
    vec3 tint = texture2D(uRamp, vec2(vUv.x, 0.5)).rgb;
    float a = FILL_ALPHA * uOpacity * smoothstep(0.05, 0.4, dist);
    // Linear light; the deep navy matches the scene's clear colour (#02040a ≈ 0.0006, 0.0012, 0.003).
    gl_FragColor = vec4(mix(vec3(0.0008, 0.0014, 0.0036), tint * 0.006, exp(-dist * 0.35)), a);
  }
`;
const FILL_ALPHA = 0.82;

const hexRgb = (hex: string): Vec3 => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Vec3;

interface Stop {
  readonly s: number;
  readonly c: Vec3;
}

/** Colour at depth s: linear between the stops around it, held before the first and past the last. */
const colorAt = (stops: readonly Stop[], s: number): Vec3 => {
  const hi = stops.findIndex((x) => x.s >= s);
  if (hi < 0) return stops[stops.length - 1]!.c;
  if (hi === 0) return stops[0]!.c;
  const a = stops[hi - 1]!;
  const b = stops[hi]!;
  const t = (s - a.s) / (b.s - a.s);
  return [0, 1, 2].map((k) => a.c[k]! + (b.c[k]! - a.c[k]!) * t) as unknown as Vec3;
};

/** RTT colour along the tube: mouth → each live gate, held past the last one. Broken gates take their neighbours' colour. */
export const fillRamp = (data: Uint8Array, gates: readonly TunnelGate[], length: number): void => {
  const stops: Stop[] = [{ s: 0, c: hexRgb(MOUTH_COLOR) }, ...gates.filter((g) => !g.broken).map((g) => ({ s: g.s, c: hexRgb(g.color) }))];
  for (let i = 0; i < RAMP_SIZE; i++) {
    const c = colorAt(stops, ((i + 0.5) / RAMP_SIZE) * length);
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(c[k]!);
    data[i * 4 + 3] = 255;
  }
};

export interface Tunnel {
  readonly group: Group;
  /** Anchor the tube at the tunnel frame (re-anchored on every dive from the globe). */
  setFrame(frame: TunnelFrame): void;
  setGates(gates: readonly TunnelGate[]): void;
  update(nowMs: number, opacity: number, reducedMotion: boolean): void;
  dispose(): void;
}

export const createTunnel = (): Tunnel => {
  const group = new Group();
  group.matrixAutoUpdate = false;
  const rampData = new Uint8Array(RAMP_SIZE * 4);
  const ramp = new DataTexture(rampData, RAMP_SIZE, 1, RGBAFormat);
  ramp.colorSpace = SRGBColorSpace;
  ramp.magFilter = ramp.minFilter = LinearFilter;
  ramp.wrapS = ramp.wrapT = ClampToEdgeWrapping;
  const material = new ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment, side: BackSide, transparent: true, depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uLength: { value: 1 }, uMotion: { value: 1 }, uRamp: { value: ramp } },
  });
  const fillMaterial = new ShaderMaterial({
    vertexShader: vertex, fragmentShader: fillFragment, side: BackSide, transparent: true, depthWrite: false,
    defines: { FILL_ALPHA: FILL_ALPHA.toFixed(3) },
    uniforms: { uOpacity: material.uniforms.uOpacity!, uRamp: material.uniforms.uRamp! },
  });
  const geometry0 = new TubeGeometry(new HelixCurve(1), 8, TUBE_R, 8);
  const fill = new Mesh(geometry0, fillMaterial);
  const mesh = new Mesh(geometry0, material);
  // The cap is seen from inside the tube, facing whichever way the helix ends: draw both sides.
  const capMaterial = fillMaterial.clone();
  capMaterial.side = DoubleSide;
  capMaterial.uniforms = fillMaterial.uniforms;
  const capGlowMaterial = material.clone();
  capGlowMaterial.side = DoubleSide;
  capGlowMaterial.defines = { END_CAP: "" };
  capGlowMaterial.uniforms = material.uniforms;
  const cap = new Mesh(endCapGeometry(1), capMaterial);
  const capGlow = new Mesh(cap.geometry, capGlowMaterial);
  fill.renderOrder = cap.renderOrder = 1;
  mesh.renderOrder = capGlow.renderOrder = 2;
  fill.frustumCulled = mesh.frustumCulled = cap.frustumCulled = capGlow.frustumCulled = false;
  group.add(fill, cap, mesh, capGlow);
  let builtLength = 0;
  let gates: readonly TunnelGate[] = [];

  const rebuild = (length: number): void => {
    mesh.geometry.dispose();
    mesh.geometry = new TubeGeometry(new HelixCurve(length), Math.ceil(length * SEGMENTS_PER_UNIT), TUBE_R, RADIAL_SEGMENTS, false);
    fill.geometry = mesh.geometry;
    cap.geometry.dispose();
    cap.geometry = capGlow.geometry = endCapGeometry(length);
    builtLength = length;
    material.uniforms.uLength!.value = length;
  };

  return {
    group,
    setFrame: (f) => {
      group.matrix.copy(new Matrix4().makeBasis(new Vector3(...f.u), new Vector3(...f.v), new Vector3(...f.n)).setPosition(...f.origin));
      group.matrixWorldNeedsUpdate = true;
    },
    setGates: (g) => {
      if (g === gates) return;
      gates = g;
      const need = (g[g.length - 1]?.s ?? 0) + TAIL;
      if (need > builtLength) rebuild(Math.ceil(need / LENGTH_STEP) * LENGTH_STEP);
      fillRamp(rampData, g, builtLength);
      ramp.needsUpdate = true;
    },
    update: (nowMs, opacity, reducedMotion) => {
      material.uniforms.uTime!.value = nowMs / 1000;
      material.uniforms.uOpacity!.value = opacity;
      material.uniforms.uMotion!.value = reducedMotion ? 0 : 1;
      group.visible = opacity > 0;
    },
    dispose: () => {
      mesh.geometry.dispose();
      cap.geometry.dispose();
      material.dispose();
      fillMaterial.dispose();
      capMaterial.dispose();
      capGlowMaterial.dispose();
      ramp.dispose();
    },
  };
};
