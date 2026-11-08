import { AdditiveBlending, BackSide, FrontSide, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from "three";

/** Dark globe body radius: under the land dots (0.992) and hop nodes (1.0). */
export const GLOBE_RADIUS = 0.985;
export const ATMOSPHERE_RADIUS = 1.12;

const surfaceVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

// Near-black body with a Fresnel rim, a soft key light and a faint graticule.
// Shared by the surface and the land dots: a circular portal around uApertureDir.
export const apertureGlsl = /* glsl */ `
  uniform vec3 uApertureDir;
  uniform float uApertureCos;
  uniform vec3 uApertureGlow;
  // Strictly inside the portal (never true while closed: uApertureCos = 1).
  bool inAperture(vec3 n) {
    return dot(n, uApertureDir) > uApertureCos;
  }
  // Glow band hugging the outside of the portal edge.
  float apertureRim(vec3 n) {
    float d = uApertureCos - dot(n, uApertureDir);
    return uApertureCos < 0.99999 ? exp(-max(d, 0.0) * 260.0) : 0.0;
  }
`;

const surfaceFragment = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uRim;
  uniform vec3 uLightDir;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vWorld;
  ${apertureGlsl}
  float gridLine(float v, float step) {
    float f = abs(fract(v / step + 0.5) - 0.5) * step;
    return 1.0 - smoothstep(0.0, fwidth(v) * 1.2, f);
  }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float key = max(dot(n, normalize(uLightDir)), 0.0);
    float lat = degrees(asin(clamp(n.y, -1.0, 1.0)));
    float lon = degrees(atan(-n.z, n.x));
    float grid = max(gridLine(lat, 15.0), gridLine(lon, 15.0)) * (1.0 - abs(n.y)) * 0.05;
    if (inAperture(n)) discard;
    vec3 col = uBase * (0.7 + 0.6 * key) + uRim * (fres * 0.45 + grid) + uApertureGlow * apertureRim(n);
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const atmosphereVertex = surfaceVertex;

// Glow shell seen from outside on its back faces. Brightness peaks where the
// view ray grazes the globe limb and fades to zero at the shell edge.
const atmosphereFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uInner;
  uniform float uOuter;
  uniform float uOpacity;
  uniform vec3 uLightDir;
  varying vec3 vWorld;
  void main() {
    vec3 ray = normalize(vWorld - cameraPosition);
    float along = dot(-cameraPosition, ray);
    float miss = length(cameraPosition + ray * along); // closest approach to the centre
    float t = clamp((uOuter - miss) / (uOuter - uInner), 0.0, 1.0);
    vec3 limb = normalize(cameraPosition + ray * along);
    float lit = 0.35 + 0.65 * smoothstep(-0.4, 0.8, dot(limb, normalize(uLightDir)));
    // The shell is only meaningful seen from outside: fade it as the camera comes inside.
    float outside = smoothstep(uOuter, uOuter + 0.35, length(cameraPosition));
    float glow = pow(t, 3.5) * 1.0 * lit * outside;
    gl_FragColor = vec4(uColor * glow * uOpacity, 1.0);
  }
`;

/** Portal uniforms shared by the surface and land dots (the tunnel lane opens it at the origin node). */
export interface ApertureUniforms {
  readonly uApertureDir: { value: Vector3 };
  readonly uApertureCos: { value: number };
  readonly uApertureGlow: { value: Vector3 };
}

export const createApertureUniforms = (): ApertureUniforms => ({
  uApertureDir: { value: new Vector3(0, 0, 1) },
  uApertureCos: { value: 1 },
  uApertureGlow: { value: new Vector3(0.35, 1.3, 1.8) },
});

export interface GlobeShell {
  readonly surface: Mesh;
  readonly atmosphere: Mesh;
  setOpacity(o: number): void;
  setSurfaceOpacity(o: number): void;
  setAtmosphereOpacity(o: number): void;
  dispose(): void;
}

export const createGlobeShell = (lightDir: Vector3, aperture: ApertureUniforms = createApertureUniforms()): GlobeShell => {
  const surfaceGeom = new SphereGeometry(GLOBE_RADIUS, 128, 96);
  const surfaceMat = new ShaderMaterial({
    vertexShader: surfaceVertex,
    fragmentShader: surfaceFragment,
    side: FrontSide,
    transparent: true,
    uniforms: {
      uBase: { value: new Vector3(0.02, 0.028, 0.05) },
      uRim: { value: new Vector3(0.1, 0.55, 0.85) },
      uLightDir: { value: lightDir },
      uOpacity: { value: 1 },
      ...aperture,
    },
  });
  const surface = new Mesh(surfaceGeom, surfaceMat);

  const atmoGeom = new SphereGeometry(ATMOSPHERE_RADIUS, 96, 64);
  const atmoMat = new ShaderMaterial({
    vertexShader: atmosphereVertex,
    fragmentShader: atmosphereFragment,
    side: BackSide,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uColor: { value: new Vector3(0.18, 0.75, 1.0) },
      uInner: { value: GLOBE_RADIUS },
      uOuter: { value: ATMOSPHERE_RADIUS },
      uOpacity: { value: 1 },
      uLightDir: { value: lightDir },
    },
  });
  const atmosphere = new Mesh(atmoGeom, atmoMat);
  atmosphere.renderOrder = -1;

  return {
    surface,
    atmosphere,
    setOpacity: (o) => {
      surfaceMat.uniforms.uOpacity!.value = o;
      atmoMat.uniforms.uOpacity!.value = o;
    },
    setSurfaceOpacity: (o) => { surfaceMat.uniforms.uOpacity!.value = o; },
    setAtmosphereOpacity: (o) => { atmoMat.uniforms.uOpacity!.value = o; },
    dispose: () => { surfaceGeom.dispose(); surfaceMat.dispose(); atmoGeom.dispose(); atmoMat.dispose(); },
  };
};
