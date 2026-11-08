import { InstancedBufferAttribute, InstancedBufferGeometry, Float32BufferAttribute, Mesh, ShaderMaterial, Vector3 } from "three";
import { latLonToVec3 } from "../geo";
import { apertureGlsl, createApertureUniforms, type ApertureUniforms } from "./atmosphere";
import { decodeLandDots } from "./landgrid";

/** Radius the land dots sit at (just above the dark sphere, just below hop nodes at 1.0). */
export const DOT_RADIUS = 0.992;
const MIN_DOT_PX = 0.8; // half-width in px → ~1.6 px discs

export const landDotsUrl = new URL("../assets/landdots.bin", import.meta.url);

/** Fetches the baked lattice → flat unit-sphere xyz. */
export const loadLandDots = async (url: URL | string = landDotsUrl, fetcher: typeof fetch = fetch): Promise<Float32Array> => {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`landdots: HTTP ${res.status}`);
  const latLon = decodeLandDots(await res.arrayBuffer());
  const out = new Float32Array((latLon.length / 2) * 3);
  for (let i = 0; i < latLon.length / 2; i++) out.set(latLonToVec3(latLon[i * 2]!, latLon[i * 2 + 1]!), i * 3);
  return out;
};

const vertex = /* glsl */ `
  attribute vec3 aCenter;
  uniform float uSize;
  uniform float uMinSize;
  uniform float uRadius;
  varying vec2 vCorner;
  varying float vFacing;
  varying float vLight;
  varying float vSeed;
  varying vec3 vCenter;
  uniform vec3 uLightDir;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

  void main() {
    vec3 c = normalize(aCenter);
    vec3 up = abs(c.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t = normalize(cross(up, c));
    vec3 b = cross(c, t);
    vSeed = hash(c);
    float size = max(uSize * (0.8 + 0.4 * vSeed), uMinSize);
    vec3 world = (modelMatrix * vec4(c * uRadius + (t * position.x + b * position.y) * size, 1.0)).xyz;
    vec3 n = normalize(mat3(modelMatrix) * c);
    vFacing = max(dot(n, normalize(cameraPosition - world)), 0.0);
    vLight = max(dot(n, normalize(uLightDir)), 0.0);
    vCenter = n;
    vCorner = position.xy;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const fragment = /* glsl */ `
  ${apertureGlsl}
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vCorner;
  varying float vFacing;
  varying float vLight;
  varying float vSeed;
  varying vec3 vCenter;

  void main() {
    float d = length(vCorner);
    if (d > 1.0) discard;
    float disc = smoothstep(1.0, 0.55, d);
    // A slow scan band sweeping in longitude, plus per-dot twinkle.
    float lon = atan(vCenter.z, vCenter.x);
    float scan = pow(0.5 + 0.5 * sin(lon * 1.0 - uTime * 0.35), 24.0);
    float twinkle = 0.85 + 0.15 * sin(uTime * (0.6 + vSeed * 1.4) + vSeed * 40.0);
    float limb = smoothstep(0.0, 0.55, vFacing);
    float lit = 0.45 + 0.75 * vLight;
    if (inAperture(vCenter)) discard;
    vec3 col = mix(uColor, uHot, 0.35 * vLight + 0.6 * scan) * lit * twinkle * (0.25 + 0.75 * limb);
    col += uApertureGlow * apertureRim(vCenter) * 0.8;
    gl_FragColor = vec4(col * disc, disc * uOpacity);
  }
`;

export interface LandDots {
  readonly mesh: Mesh;
  setOpacity(o: number): void;
  update(nowMs: number): void;
  /** World size of one drawing-buffer pixel at the globe; dots never shrink below ~1.6 px (avoids moiré). */
  setPixelWorld(size: number): void;
  dispose(): void;
}

/** One instanced draw: each dot is a small disc lying flat on the sphere. */
export const createLandDots = (
  centers: Float32Array, lightDir: Vector3, aperture: ApertureUniforms = createApertureUniforms(),
): LandDots => {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute("aCenter", new InstancedBufferAttribute(centers, 3));
  geometry.instanceCount = centers.length / 3;
  const material = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSize: { value: 0.0042 },
      uMinSize: { value: 0 },
      uRadius: { value: DOT_RADIUS },
      uColor: { value: new Vector3(0.16, 0.42, 0.62) },
      uHot: { value: new Vector3(0.45, 0.95, 1.25) },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uLightDir: { value: lightDir },
      ...aperture,
    },
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return {
    mesh,
    setOpacity: (o) => { material.uniforms.uOpacity!.value = o; },
    update: (nowMs) => { material.uniforms.uTime!.value = nowMs / 1000; },
    setPixelWorld: (s) => { material.uniforms.uMinSize!.value = s * MIN_DOT_PX; },
    dispose: () => { geometry.dispose(); material.dispose(); },
  };
};
