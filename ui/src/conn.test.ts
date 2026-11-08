import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, connect, wsUrl, type ConnState } from "./conn";

describe("wsUrl", () => {
  it("uses the serving host on the agent-served page (supports --port)", () => {
    expect(wsUrl({ protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1:5000" })).toBe("ws://127.0.0.1:5000/ws");
    expect(wsUrl({ protocol: "http:", hostname: "localhost", host: "localhost:47800" })).toBe("ws://localhost:47800/ws");
  });
  it("targets the local agent from the hosted page", () => {
    expect(wsUrl({ protocol: "https:", hostname: "lightpath.blackpaw.studio", host: "lightpath.blackpaw.studio" })).toBe(
      "ws://127.0.0.1:47800/ws",
    );
  });
  it("targets the local agent from any other http origin", () => {
    expect(wsUrl({ protocol: "http:", hostname: "example.com", host: "example.com" })).toBe("ws://127.0.0.1:47800/ws");
  });
});

describe("backoffDelay", () => {
  it("doubles from 500 ms and caps at 8 s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.onclose?.(); }
}

describe("connect", () => {
  const states: ConnState[] = [];
  const msgs: unknown[] = [];
  const start = () =>
    connect({
      url: "ws://x/ws",
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      onState: (s) => states.push(s),
      onMessage: (m) => msgs.push(m),
    });
  beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; states.length = 0; msgs.length = 0; });
  afterEach(() => vi.useRealTimers());

  it("reports connecting then connected and resets failures on open", () => {
    start();
    expect(states.at(-1)).toEqual({ status: "connecting", failures: 0 });
    FakeSocket.all[0]!.onopen!();
    expect(states.at(-1)).toEqual({ status: "connected", failures: 0 });
  });

  it("reconnects with growing backoff and counts failures", () => {
    start();
    FakeSocket.all[0]!.onclose!();
    expect(states.at(-1)).toEqual({ status: "disconnected", failures: 1 });
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    expect(states.at(-1)).toEqual({ status: "connecting", failures: 1 });
    FakeSocket.all[1]!.onclose!();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("restarts backoff after a successful open", () => {
    start();
    FakeSocket.all[0]!.onclose!();
    vi.advanceTimersByTime(500);
    FakeSocket.all[1]!.onopen!();
    FakeSocket.all[1]!.onclose!();
    expect(states.at(-1)).toEqual({ status: "disconnected", failures: 1 });
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("parses messages and drops malformed ones", () => {
    start();
    const s = FakeSocket.all[0]!;
    s.onmessage!({ data: JSON.stringify({ type: "trace.done", reached: true }) });
    s.onmessage!({ data: "not json" });
    expect(msgs).toEqual([{ type: "trace.done", reached: true }]);
  });

  it("send returns false while not open, true when open", () => {
    const c = start();
    expect(c.send({ type: "trace.cancel" })).toBe(false);
    FakeSocket.all[0]!.onopen!();
    expect(c.send({ type: "trace.start", target: "example.com" })).toBe(true);
    expect(FakeSocket.all[0]!.sent).toEqual([JSON.stringify({ type: "trace.start", target: "example.com" })]);
  });

  it("close stops reconnecting", () => {
    const c = start();
    c.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
