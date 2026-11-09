// Trace entities for what is actually drawn, beside the pose entities: a pose
// can be "visible" while its dot has shrunk away and its ring has not faded in
// yet. Nodes and gates record the alpha they drew; this turns those records
// into checkTrace entities, so a dot→ring handoff gap reads as flicker.
//   g:<ttl>  the hop's marker: its node dot or its gate ring, whichever is drawn
//   l:<ttl>  the gate's label, at its own anchor
//   a:<ttl>  the arc into that hop: its highest point (its shape jumping reads as a world jump)
import type { Vec3 } from "../geo";
import { VISIBLE_OPACITY, type Projection, type TracedEntity } from "../testhooks";

export interface DrawnMark {
  /** World position it was drawn at. */
  readonly pos: Vec3;
  /** Drawn opacity (0 when not drawn at all). */
  readonly alpha: number;
}

export interface GateMark {
  readonly ring: DrawnMark;
  /** Null until the label has a place (the tunnel frame is anchored). */
  readonly label: DrawnMark | null;
}

const entity = (m: DrawnMark, project: (p: Vec3) => Projection): TracedEntity => {
  const s = project(m.pos);
  return { x: s.x, y: s.y, visible: m.alpha > VISIBLE_OPACITY && s.inFrustum, opacity: m.alpha, world: m.pos };
};

/** The highest point of each drawn globe arc, keyed by the ttl it ends at. */
export const arcEntities = (apexes: ReadonlyMap<number, DrawnMark>, project: (p: Vec3) => Projection): Record<string, TracedEntity> =>
  Object.fromEntries([...apexes].map(([to, m]) => [`a:${to}`, entity(m, project)]));

export const markEntities = (
  dots: ReadonlyMap<number, DrawnMark>, gates: ReadonlyMap<number, GateMark>, project: (p: Vec3) => Projection,
): Record<string, TracedEntity> => {
  const keys = new Set([...dots.keys(), ...gates.keys()]);
  return Object.fromEntries([...keys].flatMap((k) => {
    const dot = dots.get(k);
    const gate = gates.get(k);
    const pos = gate?.ring.pos ?? dot!.pos;
    const marker: [string, TracedEntity] = [`g:${k}`, entity({ pos, alpha: Math.max(dot?.alpha ?? 0, gate?.ring.alpha ?? 0) }, project)];
    return gate?.label ? [marker, [`l:${k}`, entity(gate.label, project)] as [string, TracedEntity]] : [marker];
  }));
};
