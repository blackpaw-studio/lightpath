# Lightpath — Spec

Date: 2026-11-07 · Status: draft, awaiting approval

## Goal

A visually striking, futuristic traceroute that shows the real router-level path from the user's own machine to a domain or IP. Browsers cannot send TTL-limited packets, so a tiny local agent runs the trace and streams hops to a web UI that renders them on a 3D globe and in a fly-through tunnel.

## Success criteria

1. One install line, one command (`lightpath`), then enter a target in the browser and watch hops appear live within ~1 s of the system `traceroute` emitting them.
2. Every hop shows TTL, IP, RTTs, reverse DNS, ASN/org, and a location marked either `measured` or `estimated`.
3. Globe ↔ tunnel transition is one continuous camera move, no hard cut, no entity teleports or flicker.
4. Agent cannot be driven by arbitrary websites (origin + Host checks) and never passes input through a shell.
5. Runs on macOS and Linux; UI works in current Chrome, Firefox, Safari (Safari via the agent-served page), down to 375 px width.

## Architecture

```
browser UI (hosted or agent-served)  ⇄ WebSocket ⇄  lightpath agent (127.0.0.1:47800)
                                                        ├─ runs system traceroute
                                                        ├─ parses hops (streaming)
                                                        └─ enriches: rDNS, ASN, geo
```

### Agent (Go, single static binary)

- **Install:** `curl -fsSL https://lightpath.blackpaw.studio/install.sh | sh` detects OS/arch and downloads the binary from GitHub Releases (built by GoReleaser in CI). Publishing releases and the hosted site requires Evan's approval at ship time.
- **Run:** `lightpath [--port 47800] [--replay <file>] [--no-open]`. Serves the embedded UI and `/ws`; opens the browser unless `--no-open`.
- **Trace:** executes `traceroute -n -q 3 -w 2 -m 30 <target>` via `exec.Command` with an argument list (no shell). Target validated as an IPv4/IPv6 literal or an RFC 1123 hostname (≤253 chars); anything else is rejected with an error event. One active trace per connection; starting a new one cancels the previous process.
- **Parse:** line-by-line streaming parser covering macOS and Linux formats: normal hops, `*` timeouts (full or partial), multiple responding IPs on one TTL line, and annotations (`!H`, `!N`, etc.).
- **Enrich** (concurrent, each with a 2 s timeout; failure leaves the field empty, never blocks the hop event — a follow-up `hop.update` event carries late data):
  - rDNS via the system resolver.
  - ASN + org via Team Cymru DNS (`origin.asn.cymru.com`, `asn.cymru.com` TXT).
  - Geo via ip-api.com batch endpoint (≤100 IPs/request, respect its 15 req/min limit with a client-side limiter; cache results per run).
  - Hostname location hints override API geo when they match a bundled table of IATA airport codes and common carrier city codes (e.g. `chcgil`, `nyc`, `fra`) → `geoSource: "hostname"`.
  - Private/CGNAT/link-local hops (RFC 1918, 100.64/10, fe80::/10) take the user's public-IP location, `geoSource: "local"`.
  - Hops with no geo: `geoSource: "estimated"`, positioned by the UI between nearest located neighbours.
- **Security:** bind `127.0.0.1` only. WebSocket upgrade requires `Origin` ∈ {`http://127.0.0.1:<port>`, `http://localhost:<port>`, `https://lightpath.blackpaw.studio`} and `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`}; otherwise 403. No other endpoints accept input.
- **Replay:** `--replay file.json` replays a recorded event stream with original timing instead of running traceroute (used by tests, demos, and motion fixtures). `--record file.json` writes one.

### Event protocol (JSON over WebSocket)

Client → agent: `{type:"trace.start", target}` · `{type:"trace.cancel"}`
Agent → client:
- `trace.started {target, resolvedIp, origin:{publicIp, lat, lon, city, asn, org}}`
- `hop {ttl, probes:[{ip|null, rttMs|null}], ip, host, asn, org, lat, lon, city, geoSource}`
- `hop.update {ttl, ...changedFields}`
- `trace.done {reached:boolean}` · `error {code, message}`

### UI (Vite + TypeScript + three.js, static)

- Hosted on Cloudflare Pages at `lightpath.blackpaw.studio` and embedded in the agent binary (same build). Connects to `ws://127.0.0.1:47800/ws`. If the connection fails, the hosted page shows an install panel with the one-liner and a link to the agent-served page (covers Safari / Local Network Access blocks).
- **Globe view:** dark sphere with dotted landmass, Fresnel atmosphere glow, bloom post-processing, slow idle rotation. Each hop: node blooms in at its position; a light pulse travels a great-circle arc (arc height ∝ distance) from the previous hop. Color by RTT: cyan (<20 ms) → violet (~80 ms) → red (>200 ms). `estimated` nodes shimmer and use a dashed arc. Camera eases to frame the newest hop.
- **Tunnel view:** button "Dive" moves the camera continuously from globe into the origin node and down a spline through the hops: a neon tunnel with a ring gate per hop labelled hostname · ASN/org · RTT, gate spacing ∝ RTT delta. "Surface" reverses the move. Timeout-only hops render as dim, broken gates.
- **HUD:** frosted-glass panels — target input + Trace button, connection status, hop list (click to focus hop in either view), RTT sparkline, attribution line (ip-api, Team Cymru, map data).
- **Motion rules:** each entity's position comes from one source per frame; no visible→hidden→visible within 1 s; `prefers-reduced-motion` replaces flights with fades and disables idle rotation. 60 fps target on a recent laptop; degrade bloom on low-end GPUs.

## Testing

- **Go (TDD):** parser against captured macOS/Linux fixtures (timeouts, partial timeouts, multipath, annotations); target validation; origin/Host checks; enrichment with fake resolver + fake HTTP (timeouts, rate limiter, cache); hostname-hint matching; replay timing with an injected clock.
- **UI unit:** great-circle interpolation, estimated-position interpolation, RTT→color, protocol reducer (hop + hop.update merging).
- **E2E/visual:** Playwright against agent `--replay` fixtures: globe screenshot after full trace, tunnel screenshot, per-frame trace of hop-node positions/visibility across the dive/surface transition asserting no jumps or flicker, install panel when agent is absent.

## Out of scope (v1)

Windows, browser-only network-level tracing, IPv6-specific visuals beyond basic support, shareable/saved traces, history, continuous mtr-style monitoring, sound.
