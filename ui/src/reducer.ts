import type { ErrorCode, Hop, Origin, ServerMsg } from "./protocol";

export interface TraceState {
  readonly status: "idle" | "running" | "done" | "error";
  readonly target: string | null;
  readonly resolvedIp: string | null;
  readonly origin: Origin | null;
  readonly hops: readonly Hop[];
  readonly reached: boolean | null;
  readonly error: { readonly code: ErrorCode; readonly message: string } | null;
  /** Bumped by every trace.started, so views can tell a new trace from the old one even for the same target. */
  readonly generation: number;
}

export const initialState: TraceState = {
  status: "idle", target: null, resolvedIp: null, origin: null, hops: [], reached: null, error: null, generation: 0,
};

const withHop = (hops: readonly Hop[], hop: Hop): readonly Hop[] =>
  [...hops.filter((h) => h.ttl !== hop.ttl), hop].sort((a, b) => a.ttl - b.ttl);

const omitType = <T extends { type: string }>(msg: T): Omit<T, "type"> =>
  Object.fromEntries(Object.entries(msg).filter(([k]) => k !== "type")) as Omit<T, "type">;

/** Pure, immutable protocol reducer. A hop.update for an unknown ttl is ignored. */
export const reduce = (state: TraceState, msg: ServerMsg): TraceState => {
  switch (msg.type) {
    case "trace.started":
      return {
        ...initialState, status: "running", target: msg.target, resolvedIp: msg.resolvedIp, origin: msg.origin,
        generation: state.generation + 1,
      };
    case "hop": {
      const hop = omitType(msg);
      return { ...state, hops: withHop(state.hops, hop) };
    }
    case "hop.update": {
      const patch = omitType(msg);
      if (!state.hops.some((h) => h.ttl === patch.ttl)) return { ...state };
      return { ...state, hops: state.hops.map((h) => (h.ttl === patch.ttl ? { ...h, ...patch } : h)) };
    }
    case "trace.done":
      return { ...state, status: "done", reached: msg.reached };
    case "error":
      return { ...state, status: "error", error: { code: msg.code, message: msg.message } };
  }
};
