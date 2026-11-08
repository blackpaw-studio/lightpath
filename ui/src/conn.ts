import { parseServerMsg, type ClientMsg, type ServerMsg } from "./protocol";

export const AGENT_PORT = 47800;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

export interface ConnState {
  readonly status: "connecting" | "connected" | "disconnected";
  /** Consecutive failures since the last successful open. */
  readonly failures: number;
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

  const dial = (): void => {
    timer = null;
    opts.onState({ status: "connecting", failures });
    const ws = new Impl(opts.url);
    socket = ws;
    ws.onopen = () => {
      isOpen = true;
      failures = 0;
      opts.onState({ status: "connected", failures });
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
      if (stopped) return;
      const delay = backoffDelay(failures);
      failures += 1;
      opts.onState({ status: "disconnected", failures });
      timer = setTimeout(dial, delay);
    };
    ws.onerror = () => {
      /* onclose follows and drives the retry */
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
      if (timer !== null) clearTimeout(timer);
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
};
