// Dev harness: HUD over a dark backdrop with sample state. ?install=1 shows the install panel.
import { mount } from "../src/hud/hud";
import { initialState, reduce } from "../src/reducer";
import type { Hop, ServerMsg } from "../src/protocol";

const hop = (ttl: number, rtt: number | null, over: Partial<Hop> = {}): ServerMsg => ({
  type: "hop", ttl,
  probes: rtt === null ? [{ ip: null, rttMs: null }, { ip: null, rttMs: null }, { ip: null, rttMs: null }]
    : [{ ip: "10.0.0." + ttl, rttMs: rtt }, { ip: "10.0.0." + ttl, rttMs: rtt * 1.1 }, { ip: "10.0.0." + ttl, rttMs: rtt * 0.95 }],
  ip: rtt === null ? null : "10.0.0." + ttl, host: null, asn: null, org: null, lat: 0, lon: 0, city: null,
  geoSource: "api", annotations: [], ...over,
});
const msgs: ServerMsg[] = [
  { type: "trace.started", target: "example.com", resolvedIp: "93.184.216.34",
    origin: { publicIp: "203.0.113.5", lat: 40, lon: -74, city: "New York", asn: 7922, org: "Comcast" } },
  hop(1, 1.2, { ip: "192.168.1.1", host: "router.lan", geoSource: "local", city: "New York" }),
  hop(2, 9.8, { host: "ae-1.core1.nyc.comcast.net", asn: 7922, org: "Comcast Cable", city: "New York", geoSource: "hostname" }),
  hop(3, 18.4, { asn: 7922, org: "Comcast Cable", city: "Ashburn" }),
  hop(4, null, { geoSource: "estimated" }),
  hop(5, 61, { host: "ae-12.edge2.lax.level3.net", asn: 3356, org: "Lumen", city: "Los Angeles" }),
  hop(6, 128, { asn: 15133, org: "Edgecast", city: "Los Angeles", geoSource: "estimated" }),
  { type: "trace.done", reached: true },
];
const state = msgs.reduce(reduce, initialState);
const install = new URLSearchParams(location.search).has("install");
const hud = mount(document.getElementById("hud-root")!, {
  onTrace: () => {}, onCancel: () => {}, onFocusHop: () => {}, onDive: () => {}, onSurface: () => {},
}, { hosted: true });
hud.render(install ? initialState : state, install ? { status: "disconnected", failures: 2, slow: true } : { status: "connected", failures: 0, slow: false });
hud.setFocus(5);
