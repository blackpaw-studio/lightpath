// Replay agents started by playwright.config.ts, one per fixture.
export interface Agent {
  readonly file: string;
  readonly port: number;
}

const DEFAULT_PORT_BASE = 47811;

/**
 * First of seven consecutive ports for the replay agents. Set
 * LIGHTPATH_E2E_PORT_BASE to run several worktrees' suites side by side.
 */
export const portBase = (env: Readonly<Record<string, string | undefined>> = process.env): number => {
  const raw = env.LIGHTPATH_E2E_PORT_BASE;
  if (raw === undefined || raw === "") return DEFAULT_PORT_BASE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65529) throw new Error(`LIGHTPATH_E2E_PORT_BASE must be a port in 1024–65529, got "${raw}"`);
  return n;
};

const base = portBase();

export const FIXTURES = {
  /** ≤3 s: estimated, timeout-only, multipath and local hops; late hop.update geo. */
  basic: { file: "basic.json", port: base },
  /** Recorded on macOS (traceroute to example.com), ~11 s with real enrichment timing. */
  real: { file: "real-macos.json", port: base + 1 },
  /** A late geo update that moves a hop across the Atlantic, then a mid-trace restart (generation bump). */
  restart: { file: "restart.json", port: base + 2 },
  /** Two routers answer, then silence: a firewalled destination (quiet finish, no TCP answer) that has an IP location. */
  firewalled: { file: "quiet-firewalled.json", port: base + 3 },
  /** A quiet gap inside Verizon, then five silent hops; the destination answers over TCP (quiet finish with a destination). */
  quietReachable: { file: "quiet-reachable.json", port: base + 4 },
  /** Brooklyn to Moscow: a Brisbane geo-IP at 10 ms (impossible), PCCW and Arelion hops, a quiet run, reached at Yandex. */
  longHaul: { file: "long-haul-moscow.json", port: base + 5 },
  /** The firewalled destination with no IP location: the trace still closes with the honest ending. */
  unlocated: { file: "quiet-firewalled-unlocated.json", port: base + 6 },
} as const satisfies Record<string, Agent>;

export const agentUrl = (a: Agent, query = "test=1"): string => `http://127.0.0.1:${a.port}/?${query}`;
