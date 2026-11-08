import { HalfFloatType, Vector2, type Camera, type Scene, type WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { initialBudget, isSoftwareRenderer, sampleFrame, type BloomTier, type FrameBudget } from "./frameBudget";

export interface BloomLook {
  readonly strength: number;
  readonly radius: number;
  readonly threshold: number;
}

export const GLOBE_BLOOM: BloomLook = { strength: 0.75, radius: 0.45, threshold: 0.62 };

export interface Bloom {
  /** Feed one frame's duration; may degrade the tier (never raises it). */
  sample(dtMs: number): void;
  setLook(look: BloomLook): void;
  render(): void;
  setSize(width: number, height: number): void;
  tier(): BloomTier;
  dispose(): void;
}

export interface BloomOptions {
  /** Fixed tier (test mode / override); disables the frame-time governor. */
  readonly pinned?: BloomTier;
}

/** UNMASKED_RENDERER_WEBGL, or "" when the extension is unavailable. */
export const rendererName = (renderer: WebGLRenderer): string => {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
};

export const createBloom = (renderer: WebGLRenderer, scene: Scene, camera: Camera, opts: BloomOptions = {}): Bloom => {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const composer = new EffectComposer(renderer);
  composer.renderTarget1.texture.type = HalfFloatType;
  composer.renderTarget2.texture.type = HalfFloatType;
  const pass = new UnrealBloomPass(size.clone(), GLOBE_BLOOM.strength, GLOBE_BLOOM.radius, GLOBE_BLOOM.threshold);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(pass);
  composer.addPass(new OutputPass());

  let budget: FrameBudget = opts.pinned
    ? initialBudget(opts.pinned, true)
    : initialBudget(isSoftwareRenderer(rendererName(renderer)) ? "off" : "full");
  let applied: BloomTier | null = null;
  let full = size;

  const apply = (): void => {
    if (budget.tier === applied) return;
    applied = budget.tier;
    pass.enabled = applied !== "off";
    const div = applied === "half" ? 2 : 1;
    pass.setSize(Math.round(full.x / div), Math.round(full.y / div));
  };
  apply();

  return {
    sample: (dtMs) => {
      budget = sampleFrame(budget, dtMs);
      apply();
    },
    setLook: (look) => {
      pass.strength = look.strength;
      pass.radius = look.radius;
      pass.threshold = look.threshold;
    },
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setSize(w, h);
      full = renderer.getDrawingBufferSize(new Vector2());
      applied = null;
      apply();
    },
    tier: () => budget.tier,
    dispose: () => {
      pass.dispose();
      composer.dispose();
    },
  };
};
