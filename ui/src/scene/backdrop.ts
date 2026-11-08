import { Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from "three";

// Full-screen radial haze behind everything: deep navy core fading to near-black.
const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;
const fragment = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uEdge;
  uniform vec3 uTint;
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p);
    vec3 col = mix(uCore, uEdge, smoothstep(0.0, 0.95, r));
    // A faint violet nebula offset from the globe for asymmetry.
    col += uTint * exp(-pow(length(p - vec2(0.45, 0.28)) / 0.45, 2.0)) * 0.6;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface Backdrop {
  readonly mesh: Mesh;
  setAspect(aspect: number): void;
  dispose(): void;
}

export const createBackdrop = (aspect: number): Backdrop => {
  const geometry = new PlaneGeometry(2, 2);
  const material = new ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment, depthWrite: false, depthTest: false,
    uniforms: {
      uCore: { value: new Vector3(0.018, 0.035, 0.07) },
      uEdge: { value: new Vector3(0.004, 0.006, 0.014) },
      uTint: { value: new Vector3(0.035, 0.012, 0.06) },
      uAspect: { value: aspect },
    },
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return {
    mesh,
    setAspect: (a) => { material.uniforms.uAspect!.value = a; },
    dispose: () => { geometry.dispose(); material.dispose(); },
  };
};
