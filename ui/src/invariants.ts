export interface EntityFrame {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  /** World-space position. When present on consecutive frames, maxJumpWorld applies (camera-independent). */
  readonly world?: readonly [number, number, number];
}
export interface Frame {
  readonly tMs: number;
  /**
   * The camera cut on this frame (reduced-motion crossfade). Screen positions
   * are not comparable across a cut, so the screen jump check skips this frame;
   * world-space and flicker checks still apply.
   */
  readonly cut?: boolean;
  /** Entities absent from a frame count as not visible. */
  readonly entities: Readonly<Record<string, EntityFrame>>;
}
export interface TraceOptions {
  readonly maxJumpPx: number;
  readonly flickerWindowMs: number;
  /** Largest world-space move per frame. Catches teleports along the view ray that screen space cannot see. */
  readonly maxJumpWorld?: number;
}
export interface Violation {
  readonly kind: "jump" | "worldJump" | "flicker" | "invalid";
  readonly id: string;
  /** Index of the frame at which the violation is observed. */
  readonly frame: number;
  readonly detail: string;
}

interface Seen {
  readonly tMs: number;
  readonly e: EntityFrame;
}

type World = readonly [number, number, number];

const checkScreen = (id: string, frames: readonly Frame[], opts: TraceOptions): Violation[] => {
  const out: Violation[] = [];
  let last: Seen | null = null;
  let prevVisible = false;
  frames.forEach((f, i) => {
    const e = f.entities[id];
    if (e?.visible !== true) {
      prevVisible = false;
      return;
    }
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
      out.push({ kind: "invalid", id, frame: i, detail: `non-finite position (${e.x}, ${e.y})` });
      prevVisible = false;
      return;
    }
    if (last && prevVisible) {
      const d = Math.hypot(e.x - last.e.x, e.y - last.e.y);
      if (d > opts.maxJumpPx && f.cut !== true) {
        out.push({ kind: "jump", id, frame: i, detail: `${d.toFixed(1)}px > ${opts.maxJumpPx}px` });
      }
    } else if (last && f.tMs - last.tMs <= opts.flickerWindowMs) {
      out.push({ kind: "flicker", id, frame: i, detail: `hidden for ${f.tMs - last.tMs}ms` });
    }
    last = { tMs: f.tMs, e };
    prevVisible = true;
  });
  return out;
};

const finite = (w: World): boolean => w.every(Number.isFinite);

/** World continuity between consecutive frames that both carry the entity, visible or not. */
const checkWorld = (id: string, frames: readonly Frame[], limit: number): Violation[] => {
  const out: Violation[] = [];
  let prev: World | null = null;
  frames.forEach((f, i) => {
    const w = f.entities[id]?.world;
    if (!w) {
      prev = null;
      return;
    }
    if (!finite(w)) {
      out.push({ kind: "invalid", id, frame: i, detail: `non-finite world position (${w.join(", ")})` });
      prev = null;
      return;
    }
    if (prev) {
      const d = Math.hypot(w[0] - prev[0], w[1] - prev[1], w[2] - prev[2]);
      if (d > limit) out.push({ kind: "worldJump", id, frame: i, detail: `${d.toFixed(3)} > ${limit} world units` });
    }
    prev = w;
  });
  return out;
};

/**
 * Per-frame screen jumps above maxJumpPx (except on declared cuts), world-space
 * jumps above maxJumpWorld, and visible→hidden→visible within flickerWindowMs.
 */
export const checkTrace = (frames: readonly Frame[], opts: TraceOptions): Violation[] => {
  const ids = [...new Set(frames.flatMap((f) => Object.keys(f.entities)))];
  const limit = opts.maxJumpWorld;
  return ids
    .flatMap((id) => [...checkScreen(id, frames, opts), ...(limit === undefined ? [] : checkWorld(id, frames, limit))])
    .sort((a, b) => a.frame - b.frame);
};
