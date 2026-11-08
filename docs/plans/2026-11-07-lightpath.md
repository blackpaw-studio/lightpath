# Lightpath — Implementation Plan

Spec: `docs/specs/2026-11-07-lightpath.md` (source of truth; if this plan conflicts with it, follow the spec). Date: 2026-11-07.

## 0. Research findings (verified 2026-11-07)

| Topic | Finding | Effect on plan |
|---|---|---|
| ip-api batch | `POST http://ip-api.com/batch`. Max 100 IPs per request (422 above that). **15 req/min per IP** (429 above that; repeated overage gets a 1 h ban). `X-Rl` = requests left, `X-Ttl` = seconds to reset; when `X-Rl` is 0 the client must wait `X-Ttl`. **The free tier has no HTTPS. Commercial use is not allowed.** Source: [ip-api batch docs](https://ip-api.com/docs/api:batch) | Token bucket of 15/min, plus honouring `X-Rl`/`X-Ttl`. HTTP is fine because the agent makes the call, not the browser. Non-commercial terms → open question Q1. |
| Team Cymru | `d.c.b.a.origin.asn.cymru.com TXT` → `"ASN \| prefix \| CC \| registry \| date"`. IPv6 uses reversed nibbles on `origin6.asn.cymru.com`. `ASnnn.asn.cymru.com TXT` → `"ASN \| CC \| registry \| date \| AS description"`. NXDOMAIN means no data. Multi-origin prefixes can return several records. Source: [Team Cymru IP→ASN](https://www.team-cymru.com/ip-asn-mapping) | Parse the pipe-separated fields; take the lowest ASN when several are returned; cache by ASN. IPv6 goes through `origin6` (the spec gives the v4 zones; v6 counts as the "basic support" the spec allows). |
| Chrome LNA | The LNA prompt has covered fetch since Chrome 142. **WebSockets have been gated since Chrome 147.** In Chrome 145 the permission split into `local-network` and `loopback-network`. Loopback is not mixed content in Chrome. Sources: [Chrome LNA blog](https://developer.chrome.com/blog/local-network-access), [blink-dev intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/lRnFRIfzDMU), [Citrix CTX696569](https://support.citrix.com/external/article/CTX696569/chrome-147-and-edge-147-local-network-ac.html) | The hosted page gets a one-time "loopback-network" prompt. If the user denies it, the socket fails and the install panel needs a "permission denied → use the agent page" hint. |
| Safari | WebKit treats `ws://` from an https page as blocked mixed content, localhost included. The bugs are still open as of Apr 2026. Sources: [WebKit 173161](https://bugs.webkit.org/show_bug.cgi?id=173161), [WebKit 281149](https://bugs.webkit.org/show_bug.cgi?id=281149), [WebKit 140624](https://bugs.webkit.org/show_bug.cgi?id=140624), [Apple forum](https://discussions.apple.com/thread/254087609) | The hosted page **always** fails in Safari, so the install panel links to `http://127.0.0.1:47800/`. This matches the spec's fallback. |
| Firefox | Since Firefox 55, loopback counts as potentially trustworthy, so ws to 127.0.0.1 from https is allowed. Source: [Bugzilla 1370861](https://bugzilla.mozilla.org/show_bug.cgi?id=1370861) | No change. |
| Versions | three **0.187.0**, Vite **8.3.6**, TypeScript 7.0.2, Vitest 5.1.0, @playwright/test 1.65.0 (pin **1.64.x**, see Q4), Go **1.27.3** (local toolchain 1.26.5), `github.com/coder/websocket` **v1.8.15**, GoReleaser **v2.20.0**. Checked via `npm view`, `go.dev/dl`, `proxy.golang.org`, GitHub API. | `go.mod`: `go 1.26`. CI uses Go 1.27.x. Pin exact npm versions. |
| Landmask | Natural Earth 1:110m land is **public domain**; attribution is optional. Source: [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/) | Bake a dot lattice from `ne_110m_land.geojson`. Credit "Natural Earth" in the attribution line. |
| Airports | OurAirports `airports.csv` (iata_code, lat/lon, type, municipality) is published as public domain: [ourairports.com/data](https://ourairports.com/data/). The fetch failed on an expired TLS cert, so **re-confirm the licence at implementation**. | Generate the IATA hint table from it. |

## 1. Repo layout

```
cmd/lightpath/main.go          flags, DI wiring, browser open
internal/protocol/             Go event types + JSON encode (mirror of ui/src/protocol.ts)
internal/target/               Validate(), CommandFor(target, goos) → (name, args)
internal/trace/                parser.go (streaming), runner.go (exec, cancel), fixtures/*.txt
internal/enrich/               classify.go, rdns.go, cymru.go, ipapi.go (limiter+cache), hints.go,
                               hints_table.go (generated), origin.go, enricher.go (orchestrator)
internal/replay/               clock.go (Clock iface), player.go, recorder.go
internal/server/               guard.go (Origin/Host), ws.go (session: 1 trace/conn), static.go
internal/browser/              open.go (open / xdg-open, arg list)
tools/genhints/                OurAirports CSV + carrier codes → hints_table.go
ui/                            Vite app; ui/embed.go (package ui, //go:embed all:dist)
  src/protocol.ts reducer.ts geo.ts color.ts estimate.ts invariants.ts
  src/scene/ globe.ts atmosphere.ts landdots.ts arcs.ts nodes.ts tunnel.ts gates.ts
             poses.ts camera.ts transition.ts bloom.ts loop.ts
  src/hud/   hud.ts hoplist.ts sparkline.ts status.ts install.ts styles.css
  src/conn.ts main.ts testhooks.ts
  scripts/bake-landdots.ts     → src/assets/landdots.bin (committed)
  public/install.sh            served by Pages at /install.sh
  e2e/ *.spec.ts, fixtures/*.json (replay fixtures)
.goreleaser.yaml  .github/workflows/{ci,release}.yml  Makefile  install_test.sh
```

`ui/dist/.gitkeep` is committed so `go build`/`go test` compile without a UI build. `static.go` serves a placeholder when `index.html` is missing.

## 2. Event protocol

```ts
// ui/src/protocol.ts
export type GeoSource = "api" | "hostname" | "local" | "estimated"; // api|hostname|local ⇒ badge "measured"
export interface Probe { ip: string | null; rttMs: number | null }
export interface Origin { publicIp: string|null; lat: number|null; lon: number|null; city: string|null; asn: number|null; org: string|null }
export interface Hop { ttl: number; probes: Probe[]; ip: string|null; host: string|null; asn: number|null;
  org: string|null; lat: number|null; lon: number|null; city: string|null; geoSource: GeoSource; annotations: string[] }
export type ClientMsg = { type: "trace.start"; target: string } | { type: "trace.cancel" };
export type ServerMsg =
  | { type: "trace.started"; target: string; resolvedIp: string|null; origin: Origin }
  | ({ type: "hop" } & Hop)
  | ({ type: "hop.update"; ttl: number } & Partial<Omit<Hop,"ttl"|"probes">>)
  | { type: "trace.done"; reached: boolean }
  | { type: "error"; code: ErrorCode; message: string };
export type ErrorCode = "invalid_target"|"bad_message"|"traceroute_missing"|"traceroute_failed"|"busy_replay";
```

Go (`internal/protocol`) uses the same fields, with `*string`, `*float64` and `*int` for nullables. `hop.update` is built as a `map[string]any` holding only the changed keys plus `type` and `ttl`. `annotations` carries `!H`/`!N`/… from the parser, which the spec requires to be parsed. Hop `ip` is the first non-null probe IP, and only that IP is enriched.

## 3. Replay fixture format

```json
{ "version": 1, "recordedAt": "2026-11-07T22:00:00Z",
  "events": [ { "t": 0, "event": {"type":"trace.started", ...} }, { "t": 412, "event": {"type":"hop", ...} } ] }
```

`t` is the offset in milliseconds from trace start. In replay mode, `trace.start` with any target replays the whole stream at the original offsets. The target is ignored and the recorded `trace.started.target` is sent. `trace.cancel` stops playback. `--record` writes this format from a live trace's outbound events. E2E fixtures are hand-edited to be short (≤ 3 s). They include one estimated hop, one timeout-only hop, one multipath hop and one `local` hop.

## 4. Milestones and steps

Parallelism: M0 runs first. After it, **M1 (A–D) and M2-E run in parallel**. F and H run in parallel after E. G runs after F. M3 runs after M1 and M2. M4 can start any time after M0. Every step commits on its branch and reports the hash.

### M0 — Scaffold (1 implementer, effort medium)
**S0.1 Skeleton + protocol types.** Create `go.mod` (`module github.com/blackpaw-studio/lightpath`, Q2), `internal/protocol`, `ui/` (Vite 8 vanilla-ts, three 0.187.0, Vitest, Playwright 1.64.x, eslint), `ui/embed.go`, `Makefile` (`ui`, `build`, `test`, `e2e`), and a minimal `ci.yml` (go vet/test, ui typecheck/vitest).
- Failing test: `protocol_test.go` round-trips each event against golden JSON in `internal/protocol/testdata/*.json`. `protocol.test.ts` parses the same golden files, shared through a symlink or a copy step, and type-checks them.
- Verify: `go test ./... && (cd ui && npm ci && npx vitest run && npx tsc --noEmit)`.

### M1 — Agent (lanes A–D in parallel; effort: A medium, B high, C high, D high/security)

**A. S1.1 Target validation + command builder** (`internal/target`)
- Failing tests (table-driven): v4/v6 literals pass via `netip.ParseAddr`, zone IDs are rejected. RFC 1123 hostnames pass: ≤ 253 chars total, labels 1–63 chars, `[A-Za-z0-9-]`, no leading or trailing `-`, one optional trailing dot. Rejected: `-foo`, `a b`, `;rm`, `$(x)`, empty, 254 chars, a label of 64 chars, Unicode (no IDN in v1). A leading `-` is the argv-injection vector even without a shell.
- `CommandFor`: darwin + v6 literal → `traceroute6 -n -q 3 -w 2 -m 30 <t>`. Otherwise → `traceroute -n -q 3 -w 2 -m 30 <t>`, with Linux auto-detecting v6. Tests assert the exact argv per GOOS.

**B. S1.2 Streaming parser** (`internal/trace/parser.go`)
- Fixtures: capture real `traceroute -n` output on macOS (this host) and on Linux (Docker `debian` + the `traceroute` package, i.e. Butskoy). Hand-write synthetic fixtures for multipath, partial `*`, full `* * *`, `!H !N !X !P !S !A !<n>`, and continuation lines (macOS prints extra IPs on the same line; some Linux versions do too). Mark synthetic files `# synthetic`.
- Failing tests: `Parse(io.Reader) <-chan Event` yields `Header{target, resolvedIp}` from the `traceroute to X (IP)` line, read from stderr on macOS and stdout on Linux (the runner merges both). Then one `Hop` per TTL line with exactly 3 probes in order and nulls for `*`. Garbage lines are skipped without stopping the stream. Streaming test: an `io.Pipe` writes line 1 and the test asserts hop 1 arrives before line 2 is written.
- **S1.3 Runner** (`runner.go`): `Runner{Exec func(ctx,name,args) (Cmd, error)}` (DI). It uses `exec.CommandContext` with an argv list and `WaitDelay`. Cancel kills the process. `exec.ErrNotFound` → `traceroute_missing`. Non-zero exit with no hops → `traceroute_failed`. `trace.done.reached` = the last hop's IP equals resolvedIp. Tests use a fake Cmd fed from fixtures. Real exec is never run in tests.
- **Buffering spike (do first, manually):** confirm macOS and Linux traceroute flush per line when piped. If not, run under a pty (`github.com/creack/pty`, still no shell). Record the outcome in the commit message.

**C. Enrichment** (`internal/enrich`). All network access sits behind interfaces: `TXTResolver`, `AddrResolver`, `HTTPDoer`, `Clock`.
- **S1.4 classify.go**: `IsLocal(addr)` = `IsPrivate()` (RFC 1918 + fc00::/7) ∪ `IsLinkLocalUnicast()` (169.254/16, fe80::/10) ∪ 100.64.0.0/10. Table test.
- **S1.5 cymru.go**: build the v4 reversed-octet name and the v6 nibble name. Parse origin and AS TXT records. Multi-record → lowest ASN. Org = AS description. Per-run cache by /24 (v4) or /64 (v6) and by ASN. Tests: golden TXT strings, NXDOMAIN → empty, a 2 s timeout via a fake resolver blocking on ctx.
- **S1.6 rdns.go**: `LookupAddr`, trim the trailing dot, take the first name. 2 s ctx. Test with a fake.
- **S1.7 ipapi.go**: a batcher collects IPs for ≤ 250 ms or until 100 have queued, then sends one POST to `http://ip-api.com/batch?fields=status,message,query,lat,lon,city,countryCode`. The limiter is `golang.org/x/time/rate` (15 per 60 s, burst 15) with an injected clock. Responses update `X-Rl`/`X-Ttl`: when `X-Rl` is 0, block for `X-Ttl` s. A 429 is treated as `X-Rl`=0. Per-run cache. Local IPs are never sent. Failing tests with a fake HTTP doer: 150 IPs → 2 requests; the 16th request inside a minute waits (fake clock); `X-Rl:0,X-Ttl:30` defers the next request; a cache hit makes no request; a 2 s caller deadline returns empty while the batch is still pending; malformed JSON → empty.
- **S1.8 hints.go + tools/genhints**: generate `hints_table.go` from OurAirports (`large_airport`/`medium_airport` with `iata_code`) plus a hand-curated carrier city-code list (`chcgil, nycmny, lsanca, dllstx, asbnva, frnkge, londen, …`, with the city name and lat/lon in source). Matching: lowercase the rDNS name, split on `.`/`-`, strip trailing digits from each token. A token matches when it is a curated carrier code (6 chars), or an IATA code that is a whole token not on a stoplist (`ae, xe, ge, core, gw, …`, plus any 3-letter token in the generic-word list). Check labels right-to-left, skipping the registrable domain. Tests: `ae-1.r21.chcgil09.us.bb.gin.ntt.net` → Chicago; `be2.fra.as.example.net` → FRA; `core1.example.com` → no match; `lax.example.com` (apex label) → no match.
- **S1.9 origin.go**: `GET http://ip-api.com/json/?fields=status,query,lat,lon,city` plus a Cymru lookup of the public IP. Fetched once at agent startup and cached. `trace.started` waits up to 2 s for it, then sends whatever is known.
- **S1.10 enricher.go (orchestrator)**: `Enrich(ctx, hop, emit func(protocol.HopUpdate))`.
  1. The synchronous part fills the hop from caches and classification: a local hop takes the origin's lat/lon/city, `geoSource:"local"`. The `hop` event is emitted **immediately** with `geoSource:"estimated"` if no geo is known yet.
  2. rDNS, Cymru and ip-api run concurrently, each with a 2 s timeout.
  3. When rDNS returns, the hint check runs, and a match overrides API geo with `"hostname"`. Hint precedence is held even when ip-api resolves later.
  4. Each completion emits a `hop.update` containing only changed fields.

  Tests with fakes: the hop is emitted before any enrichment resolves; late ASN → an update with exactly `{asn, org}`; hint overrides API in both arrival orders; all failing → no update and estimated geo.

**D. Server + replay + CLI** (`internal/server`, `internal/replay`, `cmd/lightpath`)
- **S1.11 guard.go**: `CheckUpgrade(r, port) error`. Origin ∈ {`http://127.0.0.1:P`, `http://localhost:P`, `https://lightpath.blackpaw.studio`}, exact string match. Host ∈ {`127.0.0.1:P`, `localhost:P`}. A missing Origin is rejected. Failing tests: each allowed pair passes. Rejected cases: `http://evil.com`, `https://lightpath.blackpaw.studio.evil.com`, `http://lightpath.blackpaw.studio` (wrong scheme), `null`, Host `evil.com:P` (DNS rebinding), wrong port, IPv6 `[::1]`. An httptest request gets 403 on rejection. After the guard passes, `websocket.Accept` runs with `OriginPatterns` set to the three hosts as defence in depth.
- **S1.12 ws.go session**: read limit 4 KiB. Unknown or invalid JSON → `error bad_message`. `trace.start` validates via `target.Validate` (→ `invalid_target`), cancels any running trace and starts a new one. `trace.cancel` cancels. Disconnect cancels. Events go out through a single writer goroutine. `trace.started` is ordered before hops: hops are buffered until it has been sent. Tests: `httptest.Server` + coder/websocket client + fake runner/enricher. Covered: a second start cancels the first (the fake runner sees ctx.Done), invalid target, the ordering guarantee, and teardown on disconnect.
- **S1.13 replay**: `Clock{Now(); After(d)}` plus a fake clock. Player tests: events go out at their offsets as the fake clock advances; nothing goes out early; cancel stops playback; a malformed or unsupported-version file errors at load. Recorder test: sink events with fake times → golden JSON.
- **S1.14 main.go**: flags `--port` (default 47800), `--replay`, `--record`, `--no-open`. Listens on `127.0.0.1:port` only, with a clear error if the port is in use. Serves the embedded UI (GET) and `/ws`. `browser.Open("http://127.0.0.1:P/")` via `open`/`xdg-open` with an argv list. Tests: flag parsing (DI'd `run(args, deps)`), and the listener address must be loopback.

**S1.15 Integration** (after A–D, effort medium): wire the real runner, enricher and server. Smoke test: `go run ./cmd/lightpath --replay ui/e2e/fixtures/basic.json --no-open` plus a scripted ws client in a Go test using `--replay`. Verify: `go test -race ./...`.

### M2 — UI

**E. S2.1 Pure logic** (effort medium; Vitest; can start right after M0)
- `geo.ts`: latLon→vec3 on the unit sphere; `slerpGreatCircle(a,b,t)`; `arcPoints(a,b,n)` with altitude `h = k·θ` (θ = angular distance), radius `1 + h·sin(πt)`. Tests: endpoints exact, midpoint on the great circle, antipodal fallback axis, `h` monotonic in distance.
- `estimate.ts`: an estimated hop is placed on the great circle between its nearest located neighbours at fraction (ttl−prevTtl)/(nextTtl−prevTtl). One-sided → that neighbour (origin for the leading side). None → origin. Tests for each case.
- `color.ts`: RTT = mean of non-null probes, null → dim grey. Stops: cyan `#22e6ff` ≤ 20 ms → violet `#9b5cff` at 80 → red `#ff3b4f` ≥ 200, linear in OKLab. Tests at the stops, clamps and midpoints.
- `reducer.ts`: `reduce(state, msg)`. `trace.started` resets. `hop` inserts by ttl. `hop.update` shallow-merges into an existing ttl and is ignored for an unknown ttl. `trace.done`/`error` set status. The reducer is immutable (returns new objects). Tests for every branch, including an update arriving before its hop.
- `invariants.ts` (motion guard, test-first against synthetic traces): `checkTrace(frames, {maxJumpPx, flickerWindowMs: 1000})` reports per-frame screen jumps above the limit and visible→hidden→visible within 1 s per entity. RED with a teleport trace and a flicker trace, GREEN with a smooth trace.

**F. S2.2 Globe** (effort high; after E; parallel with H)
- `landdots.ts` + `scripts/bake-landdots.ts`: a Fibonacci lattice of about 60 k points with a point-in-polygon test against Natural Earth 110m land produces a packed `Int16` lat/lon `.bin` (~100 KB, committed). Rendered as one `InstancedMesh` of small discs, or as `Points` with a round-sprite shader, on a dark sphere (`#05070d`, slight rim).
- `atmosphere.ts`: a back-side sphere at r = 1.12 with additive blending and Fresnel `pow(1 − |dot(n,v)|, 3)` tinted cyan.
- `bloom.ts`: `EffectComposer` + `UnrealBloomPass` (three/addons) + `OutputPass`. A frame-time monitor (rolling 120 frames) degrades the pass: avg > 20 ms → half-res bloom; > 28 ms → bloom off. Also off when the WebGL renderer reports SwiftShader or software rendering. Each degradation step happens once and is never re-raised (no oscillation).
- `nodes.ts`: each hop node scales from 0 with ease-out-back over 400 ms ("bloom in") and is coloured by RTT. Estimated nodes shimmer through a shader time-uniform noise on emissive intensity; opacity stays ≥ 0.6, so they never vanish.
- `arcs.ts`: `Line2`/`LineMaterial` (three/addons fat lines) along `arcPoints`. A pulse shader uniform `head ∈ [0,1]` draws a bright travelling segment over 800 ms, then a resting glow. Estimated hops use a dashed arc (`dashed: true`).
- `camera.ts`: an orbit target that eases (critically damped spring) to frame the newest hop plus the origin. Slow idle rotation of the globe group (0.02 rad/s) runs when no trace is active. Under reduced motion there is no idle rotation, and framing changes are an instant set followed by a 300 ms opacity fade of the scene.
- Render loop `loop.ts`: `step(dtMs)` is driven by rAF in production, or by `testhooks.ts` (`?test=1` exposes `window.__lightpath = {step, dive, surface, trace(), state()}` and disables rAF and the wall clock).
- Verify: Vitest for pure helpers; a manual capture under `npm run dev` with a replay agent.

**H. S2.3 HUD + connection** (effort medium; after E; parallel with F)
- `conn.ts`: if `location.protocol==="http:"` and the hostname is `127.0.0.1`/`localhost` → `ws://${location.host}/ws` (agent-served; supports `--port`). Otherwise → `ws://127.0.0.1:47800/ws`. Reconnects with backoff (0.5→8 s). Status chip: connecting / connected / disconnected.
- `install.ts`: shown only on the hosted page after the first failure. Contains the one-liner with a copy button, then `lightpath`, and a link to `http://127.0.0.1:47800/`. Copy for the LNA case: "If your browser blocked local network access, allow it or open the agent page." Copy for Safari: "use the agent page".
- `hud.ts`/`styles.css`: frosted panels (`backdrop-filter: blur(14px)`, translucent `#0b1020cc`). Target input + Trace button (submit → `trace.start`). Hop list rows show TTL · IP · host · ASN/org · RTTs · `measured`/`estimated` badge. Clicking a row → `focusHop(ttl)` in the current view. `sparkline.ts`: inline SVG of mean RTT per TTL. Attribution line: "Geo: ip-api.com · ASN: Team Cymru · Map: Natural Earth". Layout collapses to a bottom sheet at < 640 px and works down to 375 px with no horizontal overflow.
- Tests: Vitest + jsdom for the conn URL rule and the reducer → DOM render of a hop row (badge mapping api/hostname/local → measured).

**G. S2.4 Tunnel + transition** (effort xhigh; after F)
- `poses.ts`: the **single per-frame pose source**. `computePoses(state, viewT, time) → Map<ttl, {pos, scale, opacity}>` is called once per frame. Node meshes, arcs' endpoints, gates and labels all read from it.
- `tunnel.ts`: a local frame anchored at the origin node, with +z along the inward surface normal. Gate arc-length `s_i = s_{i-1} + max(minGap, k·max(0, rtt_i − rtt_{i−1}))` with `minGap = 0.6`. Gate positions follow a gentle helix (x,y = r·sin/cos(s·ω)) → `CatmullRomCurve3`. A `TubeGeometry` gets a shader with scrolling neon grid lines and fog fade.
- `gates.ts`: a `TorusGeometry` ring per hop, coloured by RTT. Timeout-only hops get a dim (30 %) ring built from 6 arc segments with gaps. Labels are `CSS2DObject` (hostname · ASN/org · RTT) whose opacity follows the pose.
- `transition.ts`: `viewT ∈ [0,1]`, eased (cubic in-out over 2.4 s).
  - Camera: a single `CatmullRomCurve3` through: current globe camera pose → a point above the origin node → the origin node → the tunnel spline start → a short way down the tunnel. Look-at is interpolated along a parallel target curve.
  - Hop poses: `lerp(globePos, gatePos, smoothstep(0.35, 0.85, viewT))` in world space. Every entity moves continuously and nothing is ever toggled hidden.
  - Globe dots, atmosphere and arcs fade opacity from 1 to 0 over viewT 0.5→0.9. Gates and tunnel fade in over 0.4→0.8. Labels fade in over 0.8→1.
  - "Surface" plays the same curves with viewT going 1→0.
  - Under reduced motion: no camera flight; a 400 ms crossfade between the two final camera poses, while poses stay continuous.
- `focusHop` in the tunnel moves the camera along the spline to that gate's s.
- Tests: Vitest for gate spacing (negative deltas clamp to minGap), timeout-gate selection, and `computePoses` continuity (sample viewT at 1/600 steps → max Δpos bounded). Also run `invariants.ts` on a trace generated from `computePoses` under a projected camera path (unit-level, no browser).

### M3 — Integration + E2E (1 implementer, effort high; after M1, M2)
**S3.1 Wire-up**: `main.ts` composes conn → reducer → scene/HUD. Each step dispatches the "Dive"/"Surface" buttons through `transition`.

**S3.2 Playwright** (`ui/e2e`, `playwright.config.ts`)
- `webServer` runs `../lightpath --replay e2e/fixtures/basic.json --no-open --port 47811` (built binary). Projects: chromium, webkit, firefox. Viewports: 1280×720 and 375×812.
- `globe.spec`: load `?test=1`, submit a target, step until `state().status==="done"`, then `toHaveScreenshot` (bloom forced to its fixed tier in test mode for determinism).
- `tunnel.spec`: `dive()` + step to the end → screenshot.
- `transition.spec`: dive, stepping 16.67 ms per frame. Each frame records `trace()` (per hop: screen xy, world pos, `visible = opacity>0.01 && inFrustum`). Then surface. Assert `checkTrace` passes (maxJumpPx = 48 at 1280 px, derived from peak camera speed and noted in the test) and no flicker. Repeat with `reducedMotion: 'reduce'`, and also assert the globe rotation angle stays constant across frames.
- `install.spec`: `page.route('https://lightpath.blackpaw.studio/**')` fulfils from `dist/`, and `page.routeWebSocket('ws://127.0.0.1:47800/ws', ws => ws.close())`. Expect the install panel, the one-liner and the agent link.
- `responsive.spec`: at 375 px, `document.documentElement.scrollWidth ≤ innerWidth` and the hop list is reachable.
- `hop-fields.spec`: every row in the hop list shows TTL, IP or `*`, RTTs, host, ASN/org and the measured/estimated badge (spec success criterion 2).

**S3.3 Real-run check (manual, not CI)**: `lightpath` → trace `example.com` and `1.1.1.1` on macOS. Confirm hops appear ≤ 1 s after the line completes (log timestamps vs ws receive). Same check on Linux (Nomad node or Docker with `--cap-add NET_RAW` if needed).

**S3.4 Motion sign-off**: use the `record-web-motion` skill on the dive/surface at native pixels. The orchestrator posts the capture to Evan.

Verify: `make test && heavy make e2e` (background; on the remote Apollo server per the Playwright rule, Firefox locally).

### M4 — Distribution (1 implementer, effort medium; parallel after M0; **nothing published**)
- **S4.1 `.goreleaser.yaml`** (v2): a `before.hooks` step runs `npm ci --prefix ui && npm run build --prefix ui`. Builds darwin/linux × amd64/arm64 with `CGO_ENABLED=0`, `-trimpath`, `-ldflags "-s -w -X main.version={{.Version}}"`. Archive `lightpath_{{.Os}}_{{.Arch}}.tar.gz` (versionless, so `releases/latest/download/` works). `checksums.txt` (sha256). Verify: `goreleaser release --snapshot --clean` (local, no publish) and check the archive list.
- **S4.2 `release.yml`**: on tag `v*`, `goreleaser/goreleaser-action` with `GITHUB_TOKEN`. `ci.yml` grows jobs for go (`vet`, `test -race`), ui (tsc, eslint, vitest, build) and e2e (ubuntu, `npx playwright install --with-deps`, all three projects).
- **S4.3 `ui/public/install.sh`** (POSIX sh, `set -eu`):
  - `uname -s/-m` → darwin|linux × amd64|arm64 (aarch64→arm64, x86_64→amd64). Anything else → exit 1 with a message.
  - Downloads the archive and `checksums.txt` from `${LIGHTPATH_BASE_URL:-https://github.com/<owner>/lightpath/releases/latest/download}` with curl, falling back to wget.
  - Verifies sha256 (`shasum -a 256` / `sha256sum`).
  - Installs to `/usr/local/bin` if writable, else `~/.local/bin` with a PATH hint. Warns if `traceroute` is not on PATH (Debian/Ubuntu: `apt install traceroute`).
  - Test first: `install_test.sh` serves fake archives from a temp dir via a `file://` base URL and covers each uname mapping (stubbed `uname` on PATH), a checksum mismatch (must fail), and an unsupported arch. Also `shellcheck`.
- **S4.4 Pages config**: `ui/public/_headers` (cache rules only). `wrangler.toml` is documented but **not deployed**.
- **Ship gate (orchestrator, after Evan approves exact commands):** `git tag v0.1.0 && git push origin v0.1.0`, `wrangler pages deploy ui/dist --project-name lightpath`, and the DNS record for `lightpath.blackpaw.studio`.

## 5. Spec coverage check
SC1 → S1.14, S4.3, S3.3 · SC2 → S1.10, S2.3, hop-fields.spec · SC3 → S2.4, transition.spec, S3.4 · SC4 → S1.1, S1.3, S1.11 · SC5 → S1.1 (darwin/linux argv), the Playwright projects, responsive.spec. Every Testing-section item maps to S1.1–S1.13, S2.1, S2.4 and S3.2.

## 6. Risks
1. **stdout buffering** when traceroute is piped could break the ~1 s criterion. S1.2 starts with a spike to settle it; the fallback is a pty.
2. **Linux traceroute variety**: Butskoy, inetutils and busybox print different formats, and Debian/Ubuntu ship without traceroute. v1 parses Butskoy and FreeBSD/macOS formats. Other formats → `traceroute_failed` with a hint. The install.sh warning covers a missing binary.
3. **Chrome LNA**: if a user denies the loopback prompt, Chrome does not re-prompt, and the hosted page then always fails. The install panel copy covers this. **Safari hosted is always blocked**, so the agent page is the only Safari path.
4. **ip-api**: no HTTPS, so the geo response can be spoofed on hostile networks (display-only impact). Non-commercial terms → Q1. The ban risk is mitigated by the limiter plus `X-Rl`/`X-Ttl` handling.
5. **Hostname-hint false positives** (3-letter tokens): stoplist + whole-token rule + tests. Hints may still mislocate, and they are shown as `hostname`, not `api`.
6. **First trace latency**: the origin lookup can delay `trace.started` (and buffered hops) by up to 2 s if the startup prefetch has not finished.
7. **WebGL in CI**: SwiftShader is slow and WebKit/Firefox headless WebGL on Linux can be flaky. Fixed bloom tier and deterministic stepping in test mode. Screenshot tolerance `maxDiffPixelRatio: 0.01`.
8. **IPv6 hostnames on macOS**: a host with only AAAA records under `traceroute` fails. v1 returns `traceroute_failed`, which fits the spec's "basic support".

## 7. Open questions
- **Q1** ip-api forbids commercial use. Is Lightpath (free, Blackpaw-branded) non-commercial enough, or should it plan for ip-api Pro or another provider later?
- **Q2** GitHub owner/repo for module path, releases and install.sh (`blackpaw-studio/lightpath`?).
- **Q3** Should the Host check apply to all HTTP routes (DNS-rebinding hardening for static GETs) or only to `/ws` as the spec states? The plan does `/ws` only.
- **Q4** Pin Playwright 1.64.x to use the Apollo browser server, with Linux-rendered baselines matching CI? Baseline generation against the server needs Evan's approval.
- **Q5** Unnamed geoSource for API geo: the plan uses `"api"`, shown as "measured" in the UI. OK?

## 8. Orchestrator decisions (2026-11-07)
- **Q2:** `github.com/blackpaw-studio/lightpath` (org exists; matches the domain).
- **Q3:** Host check on **all** HTTP routes (static + `/ws`); Origin check on `/ws` only. Harmless hardening against DNS rebinding.
- **Q5:** `"api"` accepted; UI badge maps api/hostname/local → measured.
- **Q4:** Pin Playwright 1.64.x and run Chromium/WebKit on the Apollo server, Firefox locally. Generating the first baselines waits for Evan's approval.
- **Q1:** Pending with Evan. It doesn't block M0–M2.
