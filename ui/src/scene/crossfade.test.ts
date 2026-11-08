import { describe, expect, it } from "vitest";
import type { TraceFrame, TracedEntity } from "../testhooks";
import { crossfadeOpacity, crossfadeTrace } from "./crossfade";

const e = (x: number, visible: boolean): TracedEntity => ({ x, y: 0, visible, opacity: visible ? 1 : 0, world: [x, 0, 0] });
const frame = (entities: Record<string, TracedEntity>): TraceFrame => ({ tMs: 0, entities });

describe("crossfadeOpacity", () => {
  it("fades the snapshot from 1 to 0 over the duration, 0 when idle", () => {
    expect(crossfadeOpacity(null, 100, 400)).toBe(0);
    expect(crossfadeOpacity(100, 100, 400)).toBe(1);
    expect(crossfadeOpacity(100, 300, 400)).toBeCloseTo(0.5, 12);
    expect(crossfadeOpacity(100, 600, 400)).toBe(0);
  });
});

describe("crossfadeTrace", () => {
  const snapshot = frame({ a: e(1, true), b: e(2, false) });

  it("while the outgoing shot is still on screen, an entity it shows counts as visible", () => {
    const live = frame({ a: e(5, false), b: e(6, false) });
    const t = crossfadeTrace(live, snapshot, 0.3);
    expect(t.entities.a).toEqual({ ...live.entities.a, visible: true });
    expect(t.entities.b).toEqual(live.entities.b);
  });

  it("a blend of two cameras is no single shot: every crossfade frame counts as a cut", () => {
    expect(crossfadeTrace(frame({ a: e(5, true) }), snapshot, 0.3).cut).toBe(true);
  });

  it("is the live frame once the snapshot has faded out", () => {
    const live = frame({ a: e(5, false) });
    expect(crossfadeTrace(live, snapshot, 0)).toBe(live);
    expect(crossfadeTrace(live, null, 0.5)).toBe(live);
  });
});
