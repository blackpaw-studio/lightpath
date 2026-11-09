// Pure view-model helpers for the hop list: formatting, labels and grouping.
import type { Hop, Probe } from "../protocol";
import type { TraceState } from "../reducer";
import { shortNetworkName } from "./network";

export type Row =
  | { readonly kind: "hop"; readonly key: string; readonly hop: Hop }
  | { readonly kind: "quiet"; readonly key: string; readonly ttls: readonly number[] };

/** Median of the replies that arrived; null when none did. */
export const medianRtt = (probes: readonly Probe[]): number | null => {
  const xs = probes.flatMap((p) => (p.rttMs === null ? [] : [p.rttMs])).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
};

/** Whole milliseconds; sub-half-millisecond replies read "<1 ms". */
export const delayText = (ms: number): string => (ms < 0.5 ? "<1 ms" : Math.round(ms) + " ms");

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const parseIpv4 = (s: string): readonly number[] | null => {
  const m = IPV4.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
};

export const isIpLiteral = (s: string): boolean =>
  parseIpv4(s) !== null || (/^[0-9a-f:.]+$/i.test(s) && (s.match(/:/g)?.length ?? 0) >= 2);

/** 100.64.0.0/10: shared address space ISPs use inside their own networks. */
export const isCgnat = (ip: string | null): boolean => {
  const v4 = ip === null ? null : parseIpv4(ip);
  return v4 !== null && v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127;
};

/** RFC1918, CGNAT, link-local, loopback, IPv6 ULA and link-local. */
export const isPrivateIp = (ip: string | null): boolean => {
  if (ip === null) return false;
  const v4 = parseIpv4(ip);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const v6 = ip.split("%")[0]!.toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
};

/** Measured (api/hostname/local) versus estimated location. */
export const hasSolidLocation = (hop: Hop): boolean => hop.geoSource !== "estimated";

/** No probe got a reply. */
export const isQuiet = (hop: Hop): boolean => hop.probes.every((p) => p.rttMs === null);

/** Primary row text: place and short network, or a plain-language name for local hops. */
export const placeLabel = (hop: Hop): string => {
  const place = hop.city === null ? null : (hasSolidLocation(hop) ? "" : "≈ ") + hop.city;
  // CGNAT past the first hop is the ISP's own gear: label it by network/place like any public hop.
  if (isPrivateIp(hop.ip) && !(hop.ttl >= 2 && isCgnat(hop.ip))) {
    if (hop.ttl !== 1) return "Local network";
    return place === null ? "Your router" : "Your router · " + place;
  }
  const parts = [shortNetworkName(hop.org, hop.asn), place].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : (hop.ip ?? "Unknown");
};

/** Collapses each run of consecutive non-responding hops into one quiet row. Keys: h<ttl> / q<firstTtl>. */
export const groupHops = (hops: readonly Hop[]): readonly Row[] =>
  hops.reduce<readonly Row[]>((rows, hop) => {
    if (!isQuiet(hop)) return [...rows, { kind: "hop", key: "h" + hop.ttl, hop }];
    const last = rows.at(-1);
    if (last?.kind === "quiet" && last.ttls.at(-1) === hop.ttl - 1) {
      return [...rows.slice(0, -1), { ...last, ttls: [...last.ttls, hop.ttl] }];
    }
    return [...rows, { kind: "quiet", key: "q" + hop.ttl, ttls: [hop.ttl] }];
  }, []);

const plural = (n: number, one: string, many: string): string => n + " " + (n === 1 ? one : many);

/** Key of the quiet run that ends a finished trace which never reached its destination, else null. */
export const trailingStopKey = (state: TraceState, rows: readonly Row[]): string | null => {
  const last = rows.at(-1);
  return state.status === "done" && state.reached === false && last?.kind === "quiet" ? last.key : null;
};

/** "N hops · M networks · X ms" (unknown parts omitted). An unreached trace stops counting at its last reply and has no final delay. */
export const summaryLine = (state: TraceState): string => {
  const responding = state.hops.filter((h) => !isQuiet(h));
  const last = responding.at(-1);
  const reached = state.reached === true;
  const hopCount = reached || !last ? state.hops.length : state.hops.indexOf(last) + 1;
  // Distinct networks by display name (AS7922 and AS33651 are both Comcast); unnamed ones by AS number.
  const networks = new Set(
    responding
      .filter((h) => !isPrivateIp(h.ip) || (h.ttl >= 2 && isCgnat(h.ip)))
      .flatMap((h) => {
        const id = shortNetworkName(h.org, h.asn) ?? (h.asn === null ? null : "AS" + h.asn);
        return id === null ? [] : [id];
      }),
  );
  const delay = reached && last ? medianRtt(last.probes) : null;
  return [
    plural(hopCount, "hop", "hops"),
    ...(networks.size > 0 ? [plural(networks.size, "network", "networks")] : []),
    ...(delay !== null ? [delayText(delay)] : []),
  ].join(" · ");
};
