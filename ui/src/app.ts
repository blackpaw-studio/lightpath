// App controller: the one place agent messages, connection state, the HUD and
// the scene meet. main.ts builds the real pieces and hands them in; tests use fakes.
import type { ConnState } from "./conn";
import type { ClientMsg, ServerMsg } from "./protocol";
import { checkLocations, type ShownState } from "./plausibility";
import { initialState, interrupt, reduce, type TraceState } from "./reducer";
import type { HudHandlers, View } from "./hud/hud";
import type { ViewMode } from "./scene/transition";

export const DISCONNECTED_MESSAGE = "Lost the connection to the agent: trace interrupted.";
export const CANCELLED_MESSAGE = "Trace cancelled.";

export interface HudLike {
  render(state: ShownState, conn: ConnState): void;
  setView(view: View): void;
  setFocus(ttl: number | null): void;
}

export interface SceneLike {
  setState(state: ShownState): void;
  dive(): boolean;
  surface(): void;
  focusHop(ttl: number): boolean;
  mode(): ViewMode;
}

export interface ControllerDeps {
  /** Sends to the agent; false when the socket is not open. */
  send(msg: ClientMsg): boolean;
  /** What the views show for a reducer state (default: implausible locations dropped). */
  derive?(state: TraceState): ShownState;
}

export interface Controller {
  readonly handlers: HudHandlers;
  attachHud(hud: HudLike): void;
  /** The scene loads after the HUD (three.js is a separate chunk). */
  attachScene(scene: SceneLike): void;
  onMessage(msg: ServerMsg): void;
  onConnState(conn: ConnState): void;
  /** Once per frame: push state to the scene and keep the HUD's Dive/Surface toggle on the scene's mode. */
  frame(): void;
  state(): TraceState;
}

/** Diving already offers Surface (it reverses the dive); surfacing offers Dive. */
export const hudView = (mode: ViewMode): View => (mode === "diving" || mode === "tunnel" ? "tunnel" : "globe");

export const createController = (deps: ControllerDeps): Controller => {
  const derive = deps.derive ?? checkLocations;
  let state: TraceState = initialState;
  let shown: ShownState = derive(state);
  let conn: ConnState = { status: "connecting", failures: 0, slow: false };
  let hud: HudLike | null = null;
  let scene: SceneLike | null = null;
  let view: View = "globe";

  const setState = (next: TraceState): void => {
    if (next === state) return;
    if (next.generation !== state.generation) hud?.setFocus(null);
    state = next;
    shown = derive(state);
    hud?.render(shown, conn);
  };

  const syncView = (): void => {
    if (!scene) return;
    const v = hudView(scene.mode());
    if (v === view) return;
    view = v;
    hud?.setView(v);
  };

  const handlers: HudHandlers = {
    onTrace: (target) => {
      deps.send({ type: "trace.start", target });
    },
    onCancel: () => {
      if (deps.send({ type: "trace.cancel" })) setState(interrupt(state, "cancelled", CANCELLED_MESSAGE));
    },
    onFocusHop: (ttl) => {
      scene?.focusHop(ttl);
    },
    onDive: () => {
      scene?.dive();
      syncView();
    },
    onSurface: () => {
      scene?.surface();
      syncView();
    },
  };

  return {
    handlers,
    attachHud: (h) => {
      hud = h;
      h.setView(view);
      h.render(shown, conn);
    },
    attachScene: (s) => {
      scene = s;
      s.setState(shown);
      syncView();
    },
    onMessage: (msg) => setState(reduce(state, msg)),
    onConnState: (next) => {
      const dropped = conn.status === "connected" && next.status !== "connected";
      conn = next;
      if (dropped && state.status === "running") setState(interrupt(state, "disconnected", DISCONNECTED_MESSAGE));
      else hud?.render(shown, conn);
    },
    frame: () => {
      scene?.setState(shown);
      syncView();
    },
    state: () => state,
  };
};
