// Globe view composition: renderer, scene graph, camera rig, bloom, and the
// per-frame flow  state → layout → PoseMap → nodes/arcs.
import { Color, NeutralToneMapping, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import type { Vec3 } from "../geo";
import type { TraceState } from "../reducer";
import { initialState } from "../reducer";
import type { Steppable } from "../loop";
import { projectFrame, type Projection, type TraceFrame } from "../testhooks";
import { createApertureUniforms, createGlobeShell } from "./atmosphere";
import { createBackdrop } from "./backdrop";
import { createBloom, type Bloom, type BloomLook } from "./bloom";
import { applyFraming, createCameraRig, type CameraRig } from "./camera";
import { sceneDestination } from "../destination";
import type { BloomTier } from "./frameBudget";
import { createGlobePoseSource, ORIGIN_KEY, rotateY, type PoseMap, type PoseSource } from "./globePoses";
import { createArcs, type ArcInfo, type ArcRun } from "./arcs";
import { createLandDots } from "./landdots";
import type { DrawnMark } from "./marks";
import { globeLayout, type GlobeLayout, type LaidHop } from "./layout";
import { createNodes, type NodeInfo } from "./nodes";
import { safeRect, toNdc, type Rect } from "./safeArea";
import { createStars } from "./stars";

/** Idle rotation, rad/s, while no trace is running (none under reduced motion). */
export const IDLE_ROTATION = 0.02;
const REDUCED_FADE_MS = 300;
const REDUCED_FADE_FLOOR = 0.5;
const ORIGIN_ARC_COLOR = "#bff6ff";

export interface GlobeViewOptions {
  readonly canvas: HTMLCanvasElement;
  /** Flat unit-sphere xyz from loadLandDots. */
  readonly landDots: Float32Array;
  readonly reducedMotion: boolean;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** Pin bloom to a tier (test mode); otherwise the frame-time governor decides. */
  readonly bloomTier?: BloomTier;
}

export interface GlobeView extends Steppable {
  setState(state: TraceState): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** The HUD panels' rects (viewport CSS pixels): the camera frames the path in what they leave free. */
  setOcclusion(panels: readonly Rect[]): void;
  /** Frame these world-space points (as drawn, idle rotation included); the rig follows the globe's rotation after. */
  frameWorld(points: readonly Vec3[]): void;
  /** Poses produced this frame (one source per frame). */
  poses(): PoseMap;
  trace(): TraceFrame;
  /** Each node's dot as drawn this frame (tracing). */
  nodeMarks(): ReadonlyMap<number, DrawnMark>;
  /** Each arc's highest point as drawn this frame, keyed by the ttl it ends at. */
  arcMarks(): ReadonlyMap<number, DrawnMark>;
  /** World point → CSS-pixel screen position through the current camera. */
  project(p: Vec3): Projection;
  /** Replace the per-frame pose source (tunnel lane: wraps createGlobePoseSource). */
  setPoseSource(source: PoseSource): void;
  /** Fade globe body, atmosphere, land dots and arcs (tunnel transition). Nodes follow their poses. */
  setGlobeOpacity(opacity: number): void;
  /** Fade each globe layer separately (the tunnel transition retires them at different times). */
  setLayerOpacity(o: GlobeLayerOpacity): void;
  /** Open a portal of `angle` radians in the globe body and land dots around world direction `dir` (0 closes it). */
  setAperture(dir: Vec3, angle: number): void;
  /** Hold the idle rotation (the tunnel is anchored to the globe while it is open). */
  setRotationPaused(paused: boolean): void;
  /** Bloom strength, radius and threshold (the tunnel wants a tighter glow than the globe). */
  setBloomLook(look: BloomLook): void;
  bloomTier(): BloomTier;
  readonly scene: Scene;
  readonly rig: CameraRig;
  readonly renderer: WebGLRenderer;
  dispose(): void;
}

export interface GlobeLayerOpacity {
  readonly surface: number;
  readonly atmosphere: number;
  readonly dots: number;
  readonly arcs: number;
}

export const nodeInfos = (state: TraceState, layout: GlobeLayout): Map<number, NodeInfo> => {
  const last = layout.hops[layout.hops.length - 1];
  const reached = (state.status === "done" && state.reached === true) || sceneDestination(state) !== null;
  return new Map<number, NodeInfo>([
    [ORIGIN_KEY, { color: ORIGIN_ARC_COLOR, estimated: false, timeout: false, role: "origin" }],
    ...layout.hops.map((h): [number, NodeInfo] => [h.ttl, {
      color: h.color, estimated: h.estimated, timeout: h.timeout,
      role: reached && h === last ? "destination" : "hop",
    }]),
  ]);
};

/**
 * For each layout hop index, the run its arc belongs to: a maximal run of
 * interpolated hops with a located hop on each side, which estimatePosition puts
 * on one great circle at their ttl fractions. Runs without both anchors (their
 * hops pile onto one point) have no entry.
 */
const runSpans = (hops: readonly LaidHop[]): ReadonlyMap<number, ArcRun> => {
  const spans = new Map<number, ArcRun>();
  for (let i = 0; i < hops.length;) {
    if (hops[i]!.located) { i++; continue; }
    let j = i;
    while (j + 1 < hops.length && !hops[j + 1]!.located) j++;
    const from = hops[i - 1];
    const to = hops[j + 1];
    if (from && to) {
      for (let k = i; k <= j + 1; k++) spans.set(k, { from: from.ttl, to: to.ttl });
    }
    i = j + 1;
  }
  return spans;
};

export const arcInfos = (layout: GlobeLayout): ArcInfo[] => {
  const spans = runSpans(layout.hops);
  return layout.hops.map((h, i) => {
    const prev = layout.hops[i - 1];
    const span = spans.get(i);
    return {
      from: prev?.ttl ?? ORIGIN_KEY,
      to: h.ttl,
      colorFrom: prev?.color ?? ORIGIN_ARC_COLOR,
      colorTo: h.color,
      estimated: h.estimated || (prev?.estimated ?? false),
      ...(span ? { span } : {}),
    };
  });
};

/** Every drawn node's position (to 3 dp): the whole path drives the framing, not just the newest hop. */
const framingKey = (layout: GlobeLayout): string =>
  [layout.origin, ...layout.hops.map((h) => h.pos)].map((p) => p?.map((x) => x.toFixed(3)).join(",") ?? "").join("|");

export const createGlobeView = (opts: GlobeViewOptions): GlobeView => {
  const renderer = new WebGLRenderer({ canvas: opts.canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(opts.pixelRatio);
  renderer.setSize(opts.width, opts.height, false);
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new Scene();
  scene.background = new Color("#02040a");
  const lightDir = new Vector3(-0.4, 0.6, 1).normalize();
  const aperture = createApertureUniforms();
  const shell = createGlobeShell(lightDir, aperture);
  const dots = createLandDots(opts.landDots, lightDir, aperture);
  const stars = createStars();
  stars.setPixelRatio(opts.pixelRatio);
  const backdrop = createBackdrop(opts.width / opts.height);
  scene.add(backdrop.mesh, stars.points, shell.atmosphere, shell.surface, dots.mesh);
  const nodes = createNodes(scene);
  const arcs = createArcs(scene);
  arcs.setResolution(opts.width, opts.height, opts.pixelRatio);

  const rig = createCameraRig(opts.width / opts.height);
  const bloom: Bloom = createBloom(renderer, scene, rig.camera, opts.bloomTier ? { pinned: opts.bloomTier } : {});
  bloom.setSize(opts.width, opts.height);

  let size = { w: opts.width, h: opts.height };
  let state: TraceState = initialState;
  /** Last real origin (globe-local); anchors a new trace whose origin has no geo yet. */
  let knownOrigin: Vec3 | null = null;
  let layout = globeLayout(state);
  let infos = nodeInfos(state, layout);
  let arcList = arcInfos(layout);
  let poseSource: PoseSource = createGlobePoseSource();
  let poses: PoseMap = new Map();
  let rotation = 0;
  let now = 0;
  let lastFraming = "";
  let fadeStart: number | null = null;
  let rotationPaused = false;
  /** A reduced-motion camera cut happened during the latest update. */
  let cutThisFrame = false;
  /** A cut made between frames (the free area changed under reduced motion), reported by the next update. */
  let pendingCut = false;
  let panels: readonly Rect[] = [];

  const pixelWorld = (): number => {
    const cam = rig.camera;
    const dist = Math.max(cam.position.length() - 1, 0.1);
    return (2 * Math.tan((cam.fov * Math.PI) / 360) * dist) / renderer.getDrawingBufferSize(drawSize).y;
  };
  const drawSize = new Vector2();
  const camRight = new Vector3();
  const camUp = new Vector3();
  const updateLight = (): void => {
    const cam = rig.camera;
    camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    lightDir.copy(cam.position).normalize().addScaledVector(camRight, -0.7).addScaledVector(camUp, 0.6).normalize();
  };

  const refreshSafeArea = (): void => {
    const before = rig.camera.position.clone();
    rig.setSafeRect(toNdc(safeRect(size, panels), size), opts.reducedMotion);
    if (opts.reducedMotion && !before.equals(rig.camera.position)) pendingCut = true;
  };

  const reframe = (): void => {
    const key = framingKey(layout);
    if (key === lastFraming) return;
    lastFraming = key;
    if (!layout.origin) return;
    const pts: Vec3[] = [layout.origin, ...layout.hops.map((h) => h.pos)];
    if (applyFraming(rig, pts, opts.reducedMotion, pts.map((p) => rotateY(p, rotation)))) {
      cutThisFrame = true;
      fadeStart = now;
    }
  };

  const project = (p: Vec3): Projection => {
    const v = new Vector3(...p).project(rig.camera);
    return {
      x: ((v.x + 1) / 2) * size.w,
      y: ((1 - v.y) / 2) * size.h,
      inFrustum: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z >= -1 && v.z <= 1,
    };
  };

  return {
    scene,
    rig,
    renderer,
    setState: (s) => {
      if (s === state) return;
      state = s;
      layout = globeLayout(s, knownOrigin);
      knownOrigin = layout.origin ?? knownOrigin;
      infos = nodeInfos(s, layout);
      arcList = arcInfos(layout);
    },
    update: (dtMs, nowMs) => {
      now = nowMs;
      cutThisFrame = pendingCut;
      if (pendingCut) fadeStart = nowMs;
      pendingCut = false;
      if (state.status !== "running" && !opts.reducedMotion && !rotationPaused) rotation += (IDLE_ROTATION * dtMs) / 1000;
      poses = poseSource({ layout, nowMs, dtMs, reducedMotion: opts.reducedMotion, rotationY: rotation });
      reframe();
      rig.setYaw(rotation);
      rig.update(dtMs);
      updateLight();
      dots.mesh.rotation.y = rotation;
      shell.surface.rotation.y = rotation;
      dots.update(nowMs);
      dots.setPixelWorld(pixelWorld());
      nodes.update(poses, infos, nowMs, opts.reducedMotion, layout.generation);
      arcs.update(poses, arcList, nowMs, opts.reducedMotion, layout.generation);
      bloom.sample(dtMs);
      if (fadeStart !== null) {
        const k = Math.min((nowMs - fadeStart) / REDUCED_FADE_MS, 1);
        opts.canvas.style.opacity = String(REDUCED_FADE_FLOOR + (1 - REDUCED_FADE_FLOOR) * k);
        if (k >= 1) fadeStart = null;
      }
    },
    render: () => bloom.render(),
    resize: (w, h, dpr) => {
      size = { w, h };
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      rig.resize(w / h);
      refreshSafeArea();
      backdrop.setAspect(w / h);
      arcs.setResolution(w, h, dpr);
      stars.setPixelRatio(dpr);
      bloom.setSize(w, h);
    },
    setOcclusion: (rects) => {
      panels = rects;
      refreshSafeArea();
    },
    frameWorld: (points) => rig.frame(points.map((p) => rotateY(p, -rotation)), opts.reducedMotion),
    poses: () => poses,
    trace: () => ({ ...projectFrame(now, poses, project), ...(cutThisFrame ? { cut: true } : {}) }),
    nodeMarks: () => nodes.marks(),
    arcMarks: () => arcs.apexes(),
    project,
    setPoseSource: (s) => { poseSource = s; },
    setGlobeOpacity: (o) => {
      shell.setOpacity(o);
      dots.setOpacity(o);
      arcs.setOpacity(o);
    },
    setLayerOpacity: (o) => {
      shell.setSurfaceOpacity(o.surface);
      shell.setAtmosphereOpacity(o.atmosphere);
      dots.setOpacity(o.dots);
      arcs.setOpacity(o.arcs);
      // Fully faded layers stop drawing (and stop writing depth over the tunnel).
      shell.surface.visible = o.surface > 0;
      shell.atmosphere.visible = o.atmosphere > 0;
      dots.mesh.visible = o.dots > 0;
    },
    setAperture: (dir, angle) => {
      aperture.uApertureDir.value.set(...dir).normalize();
      aperture.uApertureCos.value = angle > 0 ? Math.cos(angle) : 1;
    },
    setRotationPaused: (p) => { rotationPaused = p; },
    setBloomLook: (look) => bloom.setLook(look),
    bloomTier: () => bloom.tier(),
    dispose: () => {
      nodes.dispose();
      arcs.dispose();
      dots.dispose();
      shell.dispose();
      stars.dispose();
      backdrop.dispose();
      bloom.dispose();
      renderer.dispose();
    },
  };
};
