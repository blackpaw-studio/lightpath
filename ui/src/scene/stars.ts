import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial } from "three";

/** Deterministic PRNG (mulberry32) so screenshots are stable. */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const vertex = /* glsl */ `
  attribute float aSize;
  attribute float aBright;
  uniform float uPixelRatio;
  varying float vBright;
  void main() {
    vBright = aBright;
    gl_PointSize = aSize * uPixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragment = /* glsl */ `
  uniform float uOpacity;
  varying float vBright;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(vec3(0.62, 0.78, 1.0) * vBright * a * uOpacity, 1.0);
  }
`;

export interface Stars {
  readonly points: Points;
  setPixelRatio(dpr: number): void;
  dispose(): void;
}

export const createStars = (count = 2200, radius = 40): Stars => {
  const rand = rng(0x5eed);
  const pos: number[] = [];
  const size: number[] = [];
  const bright: number[] = [];
  for (let i = 0; i < count; i++) {
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    pos.push(Math.cos(phi) * r * radius, z * radius, Math.sin(phi) * r * radius);
    const b = rand() ** 3;
    size.push(1 + b * 2.2);
    bright.push(0.12 + b * 0.75);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geometry.setAttribute("aSize", new Float32BufferAttribute(size, 1));
  geometry.setAttribute("aBright", new Float32BufferAttribute(bright, 1));
  const material = new ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uPixelRatio: { value: 1 }, uOpacity: { value: 1 } },
  });
  const points = new Points(geometry, material);
  points.renderOrder = -2;
  return {
    points,
    setPixelRatio: (dpr) => { material.uniforms.uPixelRatio!.value = dpr; },
    dispose: () => { geometry.dispose(); material.dispose(); },
  };
};
