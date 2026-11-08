// Replay agents started by playwright.config.ts, one per fixture.
export interface Agent {
  readonly file: string;
  readonly port: number;
}

export const FIXTURES = {
  /** ≤3 s: estimated, timeout-only, multipath and local hops; late hop.update geo. */
  basic: { file: "basic.json", port: 47811 },
  /** Recorded on macOS (traceroute to example.com), ~11 s with real enrichment timing. */
  real: { file: "real-macos.json", port: 47812 },
  /** A late geo update that moves a hop across the Atlantic, then a mid-trace restart (generation bump). */
  restart: { file: "restart.json", port: 47813 },
} as const satisfies Record<string, Agent>;

export const agentUrl = (a: Agent, query = "test=1"): string => `http://127.0.0.1:${a.port}/?${query}`;
