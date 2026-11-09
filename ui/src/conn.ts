import { parseServerMsg, type ClientMsg, type ServerMsg } from "./protocol";

export const AGENT_PORT = 47800;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;
/** A first dial still pending after this long counts as "no agent here" for the UI. */
export const SLOW_MS = 1500;

export interface ConnState {
  readonly status: "connecting" | "connected" | "disconnected";
  /** Consecutive failures since the last successful open. */
  readonly failures: number;
  /**
   * The agent is not answering: set by the first error/close, or by the first
   * dial staying pending for SLOW_MS (a hung socket never fires close, e.g. a
   * pending Local Network Access prompt, or WebKit refusing the hosted page's
   * loopback socket with an error and no close). Cleared on open.
   */
  readonly slow: boolean;
}

export interface LocationLike {
  readonly protocol: string;
  readonly hostname: string;
  readonly host: string;
}

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];

/** True when the page is served by the agent itself (plain http on loopback). */
export const isAgentServed = (loc: LocationLike): boolean =>
  loc.protocol === "http:" && LOOPBACK_HOSTS.includes(loc.hostname);

/** Agent-served page → same host (honours --port); hosted page → default local agent. */
export const wsUrl = (loc: LocationLike): string =>
  isAgentServed(loc) ? `ws://${loc.host}/ws` : `ws://127.0.0.1:${AGENT_PORT}/ws`;

/** 0.5 s doubling, capped at 8 s. */
export const backoffDelay = (failures: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** failures);

export interface ConnOptions {
  readonly url: string;
  readonly onMessage: (msg: ServerMsg) => void;
  readonly onState: (state: ConnState) => void;
  /** Injectable for tests. */
  readonly WebSocketImpl?: typeof WebSocket;
}

export interface Connection {
  /** Returns false if the socket is not open (message dropped). */
  send(msg: ClientMsg): boolean;
  close(): void;
}

export const connect = (opts: ConnOptions): Connection => {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let stopped = false;
  let isOpen = false;
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (status: ConnState["status"]): void => opts.onState({ status, failures, slow });
  const clearSlowTimer = (): void => {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = null;
  };
  const markSlow = (): void => {
    clearSlowTimer();
    if (slow || stopped) return;
    slow = true;
    emit("connecting"); // only reachable while a dial is pending
  };

  const dial = (): void => {
    timer = null;
    emit("connecting");
    const ws = new Impl(opts.url);
    socket = ws;
    // Never close the hung socket: that could cancel a pending LNA prompt.
    if (!slow) slowTimer = setTimeout(markSlow, SLOW_MS);
    ws.onopen = () => {
      clearSlowTimer();
      isOpen = true;
      failures = 0;
      slow = false;
      emit("connected");
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        opts.onMessage(parseServerMsg(String(e.data)));
      } catch {
        // Malformed agent message: drop it, keep the stream alive.
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      isOpen = false;
      clearSlowTimer();
      if (stopped) return;
      const delay = backoffDelay(failures);
      failures += 1;
      slow = true;
      emit("disconnected");
      timer = setTimeout(dial, delay);
    };
    ws.onerror = () => {
      // onclose normally follows and drives the retry; some browsers never send it.
      if (socket === ws && !isOpen) markSlow();
    };
  };
  dial();

  return {
    send: (msg) => {
      if (!socket || !isOpen) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    close: () => {
      stopped = true;
      clearSlowTimer();
      if (timer !== null) clearTimeout(timer);
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
};
