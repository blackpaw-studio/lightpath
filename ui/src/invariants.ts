export interface EntityFrame {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}
export interface Frame {
  readonly tMs: number;
  /** A deliberate camera cut landed on this frame: the jump from the previous frame is exempt (flicker is not). */
  readonly cut?: boolean;
  /** Entities absent from a frame count as not visible. */
  readonly entities: Readonly<Record<string, EntityFrame>>;
}
export interface TraceOptions {
  readonly maxJumpPx: number;
  readonly flickerWindowMs: number;
}
export interface Violation {
  readonly kind: "jump" | "flicker";
  readonly id: string;
  /** Index of the frame at which the violation is observed. */
  readonly frame: number;
  readonly detail: string;
}

interface Seen {
  readonly tMs: number;
  readonly e: EntityFrame;
}

const checkEntity = (id: string, frames: readonly Frame[], opts: TraceOptions): Violation[] => {
  const out: Violation[] = [];
  let last: Seen | null = null;
  let prevVisible = false;
  frames.forEach((f, i) => {
    const e = f.entities[id];
    if (e?.visible !== true) {
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

/** Per-frame screen jumps above maxJumpPx, and visible→hidden→visible within flickerWindowMs. */
export const checkTrace = (frames: readonly Frame[], opts: TraceOptions): Violation[] => {
  const ids = [...new Set(frames.flatMap((f) => Object.keys(f.entities)))];
  return ids.flatMap((id) => checkEntity(id, frames, opts)).sort((a, b) => a.frame - b.frame);
};
