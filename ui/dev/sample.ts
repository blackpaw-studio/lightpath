// Hard-coded sample trace (Brooklyn → Tokyo) for the dev globe. Not shipped.
import type { Hop, ServerMsg } from "../src/protocol";

const hop = (ttl: number, ip: string | null, rtts: (number | null)[], geo: Partial<Hop> = {}): ServerMsg => ({
  type: "hop", ttl, ip, host: null, asn: null, org: null, lat: null, lon: null, city: null,
  geoSource: "estimated", annotations: [],
  probes: rtts.map((r) => ({ ip: r === null ? null : ip, rttMs: r })),
  ...geo,
});

const at = (lat: number, lon: number, city: string, geoSource: Hop["geoSource"] = "api"): Partial<Hop> =>
  ({ lat, lon, city, geoSource });

/** [virtual ms, message] */
export const sampleTimeline: readonly (readonly [number, ServerMsg])[] = [
  [200, {
    type: "trace.started", target: "example.jp", resolvedIp: "203.0.113.80",
    origin: { publicIp: "198.51.100.7", lat: 40.68, lon: -73.94, city: "Brooklyn", asn: 7922, org: "Comcast" },
  }],
  [500, hop(1, "192.168.1.1", [1.1, 0.9, 1.0], at(40.68, -73.94, "Brooklyn", "local"))],
  [900, hop(2, "100.64.0.1", [7.8, 8.4, 8.1], at(40.68, -73.94, "Brooklyn", "local"))],
  [1300, hop(3, "68.86.1.1", [11, 12, 10.5], at(40.71, -74.01, "New York"))],
  [1700, hop(4, "4.68.1.2", [14, 13.2, 15], at(39.04, -77.49, "Ashburn", "hostname"))],
  [2100, hop(5, null, [null, null, null])],
  [2500, hop(6, "195.66.224.1", [78, 76, 81], at(51.51, -0.13, "London", "hostname"))],
  [2900, hop(7, "80.249.208.1", [84, 85, 83], at(52.37, 4.9, "Amsterdam"))],
  [3300, hop(8, "80.81.192.1", [91, 90, 93], at(50.11, 8.68, "Frankfurt"))],
  [3700, hop(9, "62.115.0.9", [128, null, 131])],
  [4100, hop(10, "103.16.102.1", [174, 177, 172], at(19.08, 72.88, "Mumbai"))],
  [4500, hop(11, "27.111.228.1", [205, 211, 207], at(1.35, 103.82, "Singapore"))],
  [4900, hop(12, "203.0.113.80", [236, 241, 238], at(35.68, 139.69, "Tokyo"))],
  [5200, { type: "trace.done", reached: true }],
];
