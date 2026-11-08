// The full scene: globe view + tunnel + gates + labels, driven by the tunnel
// controller. Per frame: advance the transition → globe update (which pulls the
// single pose source) → camera from the one continuous curve → tunnel, gates
// and labels from the same poses → render.
import { Matrix4, Vector3 } from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { Vec3 } from "../geo";
import type { Steppable } from "../loop";
import type { TraceState } from "../reducer";
import type { TraceFrame } from "../testhooks";
import { GLOBE_BLOOM, type BloomLook } from "./bloom";
import { createCrossfade } from "./crossfade";
import { createGates } from "./gates";
import { createGlobeView, type GlobeView, type GlobeViewOptions } from "./globe";
import { createGlobePoseSource, ORIGIN_KEY, type PoseMap } from "./globePoses";
import { TUBE_R, createTunnel } from "./tunnel";
import { createTunnelController } from "./tunnelController";
import type { CameraPose, ViewMode } from "./transition";

/** Portal radius in the globe as a multiple of the tube's angular radius at the surface. */
/** Inside the tube the neon fills the frame: a tighter, higher-threshold bloom keeps it from washing out. */
const TUNNEL_BLOOM: BloomLook = { strength: 0.55, radius: 0, threshold: 0.9 };
const mixLook = (a: BloomLook, b: BloomLook, t: number): BloomLook => ({
  strength: a.strength + (b.strength - a.strength) * t,
  radius: a.radius + (b.radius - a.radius) * t,
  threshold: a.threshold + (b.threshold - a.threshold) * t,
});
const APERTURE_SCALE = 1.08;

export interface SceneViewOptions extends GlobeViewOptions {
  /** Container for gate labels (positioned over the canvas, pointer-events: none). */
  readonly labelLayer: HTMLElement;
  /** Overlay canvas for the reduced-motion crossfade (positioned over the canvas). */
  readonly fadeLayer: HTMLCanvasElement;
}

export interface SceneView extends Steppable {
  readonly globe: GlobeView;
  setState(state: TraceState): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Globe → tunnel. False when there is nothing to dive into yet (no origin). */
  dive(): boolean;
  /** Tunnel → globe (also reverses a dive in progress). */
  surface(): void;
  /** Tunnel: glide along the spline to that hop's gate. Globe: frame that hop. False for an unknown hop. */
  focusHop(ttl: number): boolean;
  mode(): ViewMode;
  /** 0 = globe … 1 = tunnel. */
  viewT(): number;
  poses(): PoseMap;
  /** Per-entity screen position, world position and visibility this frame (input to checkTrace). */
  trace(): TraceFrame;
  dispose(): void;
}

const vec = (v: Vector3): Vec3 => [v.x, v.y, v.z];

export const createSceneView = (opts: SceneViewOptions): SceneView => {
  const globe = createGlobeView(opts);
  const camera = globe.rig.camera;
  let size = { w: opts.width, h: opts.height };
  let rigPos: Vec3 = vec(camera.position);
  const ctl = createTunnelController({
    globeSource: createGlobePoseSource(), rigPos: () => rigPos, aspect: () => size.w / size.h, reducedMotion: opts.reducedMotion,
  });
  globe.setPoseSource(ctl.poseSource);
  const tunnel = createTunnel();
  globe.scene.add(tunnel.group);
  const gates = createGates(globe.scene);
  const labels = new CSS2DRenderer({ element: opts.labelLayer });
  labels.setSize(opts.width, opts.height);
  const crossfade = createCrossfade(opts.fadeLayer);
  const look = new Matrix4();
  let pose: CameraPose | null = null;
  let prevPose: CameraPose | null = null;
  let anchored: unknown = null;
  let now = 0;
  let generation = 0;

  const place = (c: CameraPose): void => {
    camera.position.set(...c.pos);
    camera.quaternion.setFromRotationMatrix(look.lookAt(camera.position, new Vector3(...c.look), new Vector3(...c.up)));
    if (camera.fov !== c.fovDeg) {
      camera.fov = c.fovDeg;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  };

  const applyFades = (): void => {
    const f = ctl.fades();
    globe.setLayerOpacity({ surface: f.surface, atmosphere: f.atmosphere, dots: f.dots, arcs: f.arcs });
    const frame = ctl.frame();
    globe.setAperture(frame ? frame.origin : [0, 0, 1], f.aperture * Math.asin(TUBE_R) * APERTURE_SCALE);
    globe.setBloomLook(mixLook(GLOBE_BLOOM, TUNNEL_BLOOM, f.tunnel));
  };

  return {
    globe,
    setState: (s) => {
      generation = s.generation;
      globe.setState(s);
      ctl.setState(s);
      tunnel.setGates(ctl.gates());
    },
    update: (dtMs, nowMs) => {
      now = nowMs;
      ctl.advance(dtMs);
      const mode = ctl.mode();
      globe.setRotationPaused(mode !== "globe");
      applyFades();
      globe.update(dtMs, nowMs);
      // globe.update ran the rig: its camera now holds the rig pose the flight starts from.
      rigPos = vec(camera.position);
      prevPose = pose;
      pose = ctl.camera();
      place(pose);

      const frame = ctl.frame();
      if (frame && frame !== anchored) {
        anchored = frame;
        tunnel.setFrame(frame);
      }
      const f = ctl.fades();
      tunnel.update(nowMs, f.tunnel, opts.reducedMotion);
      gates.update({
        poses: ctl.poses(), gates: ctl.gates(), depths: ctl.depths(), frame, cameraPos: pose.pos,
        generation,
        ringFade: f.gates, labelFade: f.labels, nowMs, reducedMotion: opts.reducedMotion, aspect: size.w / size.h,
      });
    },
    render: () => {
      if (ctl.cut() && prevPose && pose) {
        // Snapshot the outgoing shot for the crossfade, then render the new one.
        place(prevPose);
        globe.render();
        crossfade.capture(opts.canvas, now);
        place(pose);
      }
      globe.render();
      labels.render(globe.scene, camera);
      const fading = crossfade.update(now);
      opts.labelLayer.style.opacity = String(1 - fading);
    },
    resize: (w, h, dpr) => {
      size = { w, h };
      globe.resize(w, h, dpr);
      labels.setSize(w, h);
      if (pose) place(pose);
    },
    dive: () => ctl.dive(),
    surface: () => ctl.surface(),
    focusHop: (ttl) => {
      if (ctl.focusHop(ttl)) return true;
      if (ctl.mode() !== "globe") return false;
      const p = ctl.poses().get(ttl);
      const o = ctl.poses().get(ORIGIN_KEY);
      if (!p) return false;
      globe.rig.frame(o && ttl !== ORIGIN_KEY ? [o.pos, p.pos] : [p.pos], opts.reducedMotion);
      return true;
    },
    mode: () => ctl.mode(),
    viewT: () => ctl.viewT(),
    poses: () => ctl.poses(),
    // One cut flag per frame: the tunnel transition's shot change, or the globe
    // rig's reduced-motion cut while the rig is the camera on screen (in the
    // other modes the controller's camera overrides it, so no cut is seen).
    trace: () => {
      const t = globe.trace();
      const rigCut = t.cut === true && ctl.mode() === "globe";
      return rigCut || ctl.cut() ? { ...t, cut: true } : { ...t, cut: false };
    },
    dispose: () => {
      gates.dispose();
      tunnel.dispose();
      crossfade.dispose();
      globe.dispose();
    },
  };
};
