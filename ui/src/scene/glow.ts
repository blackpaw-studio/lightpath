import { CanvasTexture, SRGBColorSpace, type Texture } from "three";

let shared: Texture | null = null;

/** Radial glow sprite: tight bright core plus a long soft falloff. Created once, shared. */
export const glowTexture = (): Texture => {
  if (shared) return shared;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("glowTexture: 2D canvas unavailable");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.min(1, Math.exp(-r * r * 40) + 0.45 * Math.exp(-r * 6) * (1 - r));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.round(a * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  shared = new CanvasTexture(canvas);
  shared.colorSpace = SRGBColorSpace;
  return shared;
};
