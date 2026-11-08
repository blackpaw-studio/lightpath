// Mirror of internal/protocol (Go). Both are checked against
// internal/protocol/testdata/*.json.

export type GeoSource = "api" | "hostname" | "local" | "estimated"; // api|hostname|local ⇒ badge "measured"
export type ErrorCode =
  | "invalid_target"
  | "bad_message"
  | "traceroute_missing"
  | "traceroute_failed"
  | "busy_replay"
  | "busy";

export interface Probe {
  ip: string | null;
  rttMs: number | null;
}
export interface Origin {
  publicIp: string | null;
  lat: number | null;
  lon: number | null;
  city: string | null;
  asn: number | null;
  org: string | null;
}
export interface Hop {
  ttl: number;
  probes: Probe[];
  ip: string | null;
  host: string | null;
  asn: number | null;
  org: string | null;
  lat: number | null;
  lon: number | null;
  city: string | null;
  geoSource: GeoSource;
  annotations: string[];
}

export type ClientMsg = { type: "trace.start"; target: string } | { type: "trace.cancel" };
export type ServerMsg =
  | { type: "trace.started"; target: string; resolvedIp: string | null; origin: Origin }
  | ({ type: "hop" } & Hop)
  | ({ type: "hop.update"; ttl: number } & Partial<Omit<Hop, "ttl" | "probes">>)
  | { type: "trace.done"; reached: boolean }
  | { type: "error"; code: ErrorCode; message: string };

const GEO_SOURCES: readonly string[] = ["api", "hostname", "local", "estimated"];
const ERROR_CODES: readonly string[] = [
  "invalid_target", "bad_message", "traceroute_missing", "traceroute_failed", "busy_replay", "busy",
];

type Obj = Record<string, unknown>;
type Check = (v: unknown) => boolean;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === "string";
const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
const int: Check = (v) => Number.isInteger(v);
const bool: Check = (v) => typeof v === "boolean";
const nullable = (c: Check): Check => (v) => v === null || c(v);
const oneOf = (xs: readonly string[]): Check => (v) => typeof v === "string" && xs.includes(v);
const arrayOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const shape = (fields: Record<string, Check>): Check => (v) =>
  isObj(v) && Object.entries(fields).every(([k, c]) => k in v && c(v[k]));

// `satisfies` makes the compiler flag a field added to (or removed from) the
// interfaces above until its check is added here too.
const probe = shape({ ip: nullable(str), rttMs: nullable(num) } satisfies Record<keyof Probe, Check>);
const origin = shape({
  publicIp: nullable(str), lat: nullable(num), lon: nullable(num),
  city: nullable(str), asn: nullable(int), org: nullable(str),
} satisfies Record<keyof Origin, Check>);
const hopFields = {
  ip: nullable(str), host: nullable(str), asn: nullable(int), org: nullable(str),
  lat: nullable(num), lon: nullable(num), city: nullable(str),
  geoSource: oneOf(GEO_SOURCES), annotations: arrayOf(str),
} satisfies Record<keyof Omit<Hop, "ttl" | "probes">, Check>;

const serverChecks: Record<string, Check> = {
  "trace.started": shape({ target: str, resolvedIp: nullable(str), origin }),
  hop: shape({ ttl: int, probes: arrayOf(probe), ...hopFields }),
  // Every field optional, but present ones must be valid (absent ≠ null).
  "hop.update": (v) =>
    isObj(v) && int(v.ttl) && Object.entries(hopFields).every(([k, c]) => !(k in v) || c(v[k])),
  "trace.done": shape({ reached: bool }),
  error: shape({ code: oneOf(ERROR_CODES), message: str }),
};
const clientChecks: Record<string, Check> = {
  "trace.start": shape({ target: str }),
  "trace.cancel": () => true,
};

function parse<T>(text: string, checks: Record<string, Check>): T {
  const v: unknown = JSON.parse(text);
  if (!isObj(v) || typeof v.type !== "string") throw new Error("protocol: missing type");
  const check = checks[v.type];
  if (!check) throw new Error(`protocol: unknown message type ${v.type}`);
  if (!check(v)) throw new Error(`protocol: malformed ${v.type}`);
  return v as T;
}

/** Parses and validates an agent → client message; throws on malformed input. */
export const parseServerMsg = (text: string): ServerMsg => parse<ServerMsg>(text, serverChecks);
/** Parses and validates a client → agent message; throws on malformed input. */
export const parseClientMsg = (text: string): ClientMsg => parse<ClientMsg>(text, clientChecks);
