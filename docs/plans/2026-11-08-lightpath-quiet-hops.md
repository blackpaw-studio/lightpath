# Lightpath quiet hops: implementation plan

Spec: `docs/specs/2026-11-08-lightpath-quiet-hops.md`. It amends `2026-11-07-lightpath.md` and `2026-11-08-lightpath-friendlier-ux.md`; where this plan and the spec disagree, the spec wins.

## Architecture in one paragraph
**Early stop lives in the runner (`internal/trace`).** The runner already owns the traceroute process through its context. It derives `procCtx` from the caller's `ctx`, starts traceroute and the parser on `procCtx`, and cancels only `procCtx` when the quiet limit is hit. That kills the process the same way a user cancel does. The runner then reports a normal `Done{Reason: quiet}` on the caller's `ctx`, which is still live. The session (`internal/server/ws.go`) does not change.

**The destination check and the destination's enrichment live in `internal/live`.** Both start when `trace.Header` arrives, run under the trace context, and are joined before `trace.done` is sent. The enriched destination goes out inside `trace.done`, so there is no new message type.

**Most UI logic is pure functions.** `reducer.ts` stores the destination; `rows.ts` builds the rows; `layout.ts` and `tunnelLayout.ts` add a synthetic destination entry for the scene.

## Protocol (v2, additive)
- **Go `EndReason`** (string enum): `reached | quiet | limit | error | cancelled`, with a `Valid()` method.
- **Go `Destination`**: `{ip string, reachable bool, port *int, rttMs *float64, host, asn, org, lat, lon, city (pointers), geoSource GeoSource}`.
  - If `reachable`, then `port` and `rttMs` must be non-null.
  - If not `reachable`, both must be null.
- **Go `TraceDone`** gains:
  - `Reason *EndReason \`json:"reason,omitempty" lp:"optional"\``
  - `Destination *Destination \`json:"destination,omitempty" lp:"optional"\``
  - When `reason` is present, `reached` must equal `(reason == "reached")`.
- **`requireFields`** honours `lp:"optional"`: the key may be absent, but if present it must not be null (even when the Go field is a pointer).
- **TS mirror**: `EndReason`, `Destination`, and `{type:"trace.done"; reached; reason?; destination?}`. A new `shapeOpt(required, optional)` helper accepts an absent key, rejects null, and validates any value present. TS enforces the same consistency rules.
- **Versioning**:
  - `protocol.Version = 2` in Go and `PROTOCOL_VERSION = 2` in TS, each with a changelog comment ("2: trace.done gains optional reason, destination"). A vitest reads `protocol.go` and asserts the two match.
  - The replay fixture container stays at `Version = 1`.
- **Compatibility**:
  - Old agent with new UI: `reason` is absent, so the reducer derives it from `reached`.
  - New agent with old UI: `shape()` ignores extra keys, so the old UI still works.
  - Old fixtures still replay (proved in step 1 and step 8).

## Steps
Order: step 1 first. Steps 2 and 3 run in parallel. Step 4 needs 2 and 3. Step 5 needs 1. Steps 6 and 7 run in parallel after 5. Step 8 needs everything. Step 9 is the merge gate.

### 1. Protocol v2, Go and TS together
- **Files:** `internal/protocol/{protocol.go,validate.go,protocol_test.go}`, `ui/src/{protocol.ts,protocol.test.ts}`.
- **New goldens** in `internal/protocol/testdata/`:
  - `server.trace.done.quiet.json` (reachable destination with full geo)
  - `server.trace.done.unreachable.json` (`reachable:false`, null port and rttMs)
  - `server.trace.done.limit.json`
  - Keep `server.trace.done.json` unchanged as the legacy shape.
- **Failing test first:** the Go round-trip golden test and the TS golden parse both reject the new files (unknown field `reason`).
- **Rejection table, mirrored on both sides:**
  - `reason` null, `"bogus"` or `""`
  - `destination` null
  - `destination` missing `reachable`
  - `reachable:true` with null port
  - `reachable:false` with a port
  - `reached:true` with `reason:"quiet"`
- **Verify:** `go test -race ./internal/protocol/... ./internal/replay/... && cd ui && npx tsc --noEmit && npx vitest run src/protocol.test.ts`

### 2. Runner early stop and end reason (`internal/trace/runner.go`)
- **Changes:**
  - `Done` becomes `{Reached bool; Reason protocol.EndReason}`.
  - Add `const QuietLimit = 5`.
  - Add `procCtx, stopProc := context.WithCancel(ctx)`; pass it to `Exec` and `ParseContext`.
- **Loop logic:**
  - A hop is quiet when every probe RTT is nil (same as the UI's `isQuiet`).
  - `quietRun` counts only after the first responding hop; any reply resets it.
  - When `quietRun == QuietLimit`: forward that 5th hop, call `stopProc()`, stop forwarding, drain `parsed` and throw the events away, then call `Wait`.
- **After `Wait`:**
  - If `ctx.Err() != nil`, send no terminal event (user cancel wins, same as today).
  - Else if stopped early, send `Done{false, quiet}` and ignore the kill error from `Wait`.
  - Else `finish` returns `reached` or `limit`. `limit` means any finish with hops that is neither reached nor quiet (see D5).
- **Failing tests first** (`runner_test.go`):
  - Add a `blockingReader` that serves a script, then blocks until the exec ctx is done, then returns EOF.
  - Add a synthetic fixture `testdata/quiet.firewalled.synthetic.txt`: ttl 1–2 answer, 3–8 are `* * *`.
- **Cases:**
  - Exactly 7 hop events, then `Done{quiet}`, and the exec ctx was cancelled. The pending 8th hop is never forwarded.
  - Quiet hops before the first reply don't count.
  - A gap of 4 followed by a reply resets the count.
  - The caller cancels while the stop is in flight: channel closes with no terminal event.
  - `macos.reached.txt` gives `reached`; `linux.timeouts.txt` gives `limit` (if 5+ trailing quiet hops make it `quiet`, assert that instead).
- **Verify:** `go test -race ./internal/trace/...`

### 3. Destination dialer (new `internal/reach`)
- **Types:**
  - `type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)`
  - A local `Clock` interface (`Now`, `Timer`) that `enrich.RealClock` already satisfies.
  - `Checker{Dial, Clock, Ports []int /*default 443,80*/, Timeout /*2s*/, Attempts /*3*/}`
  - `Check(ctx, netip.Addr) Result{Reachable bool; Port int; RTT time.Duration}`
- **Behaviour:**
  - Connects are sequential. Each uses a 2 s timeout driven by the injected clock (copy enrich's ~15-line `withTimeout`).
  - Address is built with `net.JoinHostPort`, so IPv6 works.
  - Each connection is closed immediately; nothing is written.
  - The first port that succeeds wins. Up to 2 more connects on that port; RTT is the minimum over successes.
  - On failure, try port 80. Unreachable after both ports fail.
- **Failing tests first** (`reach_test.go`):
  - A real `127.0.0.1` listener reached through a dial wrapper that rewrites `:443` to the listener's port: reachable on 443, RTT is the minimum of three, with the fake clock advanced inside each dial.
  - 443 refused, so it falls back to 80.
  - Both ports closed: unreachable.
  - Hanging dial: the fake clock fires 2 s on 443, then 2 s on 80, then unreachable.
  - Ctx cancelled mid-dial: `Check` returns promptly and the dial goroutine has exited.
  - The fake conn sees `Close` and zero `Write` calls.
- **Verify:** `go test -race ./internal/reach/...`

### 4. Live: destination check, enrichment and done (`internal/live/source.go`, `cmd/lightpath/live.go`)
- **Config:** `live.Config.Reach` takes a small interface, `Check(ctx, netip.Addr) reach.Result`. `live.New` requires it. The real wiring is `reach.Checker{Dial: (&net.Dialer{}).DialContext, Clock: enrich.RealClock}`.
- **On `Header` with a parseable resolved IP**, `traceRun.startDest` does two things:
  - Launches one goroutine running `Check` that writes into a buffered chan of size 1.
  - Calls `Enricher.Enrich(r.ctx, Hop{TTL:0, IP:&ip}, collect)`. `collect` folds the hop and its `hop.update`s into a mutex-guarded local `Hop` and **never calls `r.emit`**.
- **On `Done`:** `waitAll()` for hops, then `destWait()` (joins the check and calls the enrichment's `wait`), then `emitIfLive(TraceDone{Reached, Reason, Destination})`.
- **No header:** the destination is omitted.
- **On `ErrorEvent` and in `drain`:** join the destination work too.
- **Failing tests first** (`source_test.go`, with fake reach and fake enricher):
  - A quiet finish carries the merged destination (asn, city, geoSource, port, rttMs).
  - Cancel while `Check` is blocked: `Trace` returns only after `Check` returns, and the emit recorder sees nothing after return.
  - Error path: no destination, goroutines joined.
  - No header: `destination` absent.
  - Update `integration_test.go` for the new `Config` field.
- **Verify:** `go test -race ./internal/live/... ./cmd/...`

### 5. Reducer (`ui/src/reducer.ts`)
- **State:** `TraceState` gains `endReason: EndReason | null` and `destination: Destination | null`.
- **On `trace.done`:**
  - `endReason = msg.reason ?? (msg.reached ? "reached" : "limit")`
  - `destination = msg.destination ?? null`
- **Other transitions:**
  - The `error` message sets `"error"`.
  - `interrupt(...,"cancelled")` sets `"cancelled"`.
  - `trace.started` resets both fields.
- **Failing tests first** (`reducer.test.ts`): legacy done, quiet done, error, cancel, restart.
- **Verify:** `npx vitest run src/reducer.test.ts`

### 6. HUD rows (`hud/rows.ts`, `hud/hops.ts`, `hud/hud.ts`)
- **`buildRows(state)`** (replaces direct `groupHops` use in `hud.ts`):
  - **Gap naming.** Each quiet row between two hop rows gets `title` from `quietRunTitle(n, before, after)`, using `shortNetworkName`:
    - Same network: "N routers inside X's network" (X ending in "s" gets a bare apostrophe).
    - Different networks: "N routers between X and Y".
    - Either side null, or no neighbour: "N routers stayed quiet".
    - Singular forms for n = 1.
  - **Trailing quiet run when `endReason === "quiet"`:**
    - If the destination is reachable, the run becomes `{kind:"destination"}`:
      - Place line: "Destination · <net> · <place> · <delay>", with missing parts omitted and "≈" for an estimated place.
      - Subtitle: "Answers directly; routers near it stay quiet."
      - Details: IP, "TCP port <p>", delay.
    - If not reachable, the run becomes `{kind:"end"}`:
      - "The destination doesn't answer traces"
      - "The path ends somewhere past <placeLabel(last responding hop)>."
  - **`trailingStopKey`** now keys on `endReason === "limit"`.
- **Summary:** `summaryLine` reads "N+ hops" for a quiet finish with a reachable destination (D7).
- **Failing tests first** (`rows.test.ts`, `hops.test.ts`): naming (same, different, unknown, run before the first reply), both quiet end rows, `N+`, and that limit and reached output is unchanged.
- **Verify:** `npx vitest run src/hud`

### 7. Scene (`scene/layout.ts`, `globe.ts`, `tunnelLayout.ts`, `gates.ts`)
- **Globe:** for a quiet finish whose reachable destination has lat/lon, `globeLayout` adds the destination to the anchors and appends a `LaidHop{ttl: maxTtl+1, estimated: true}`.
  - The trailing quiet hops re-estimate onto the great circle using the existing glide.
  - The arcs become dashed through the existing `estimated || prev.estimated` rule.
- **Tunnel:** `tunnelGates` appends a destination gate (`title "Destination"`, detail "<net> · <delay>", `estimated: true`). `gates.ts` renders estimated gates with the globe's treatment (D10).
- **No geo, or unreachable:** no destination entry.
- **Failing tests first:** `layout.test.ts` (entry present and estimated; trailing quiet positions lie between the last reply and the destination; absent when unreachable), `tunnelLayout.test.ts`, `gates.test.ts`, and an arc-info unit test (export the pure builder from `globe.ts` if it is inline).
- **Verify:** `npx vitest run src/scene`

### 8. Fixtures and E2E
- **New fixtures** in `ui/e2e/fixtures/`:
  - `quiet-firewalled.json`: ttl 1–2 answer, ttl 3–7 quiet, done `quiet`, unreachable.
  - `quiet-reachable.json`: Verizon hops, a 3-hop gap inside Verizon, then Verizon to Cloudflare, then 5 trailing quiet hops, done `quiet`, reachable destination with geo.
- **Agents:** add both to `FIXTURES` in `agents.ts` on ports `base+3` and `base+4`.
- **Go replay test:** `internal/replay/fixture_test.go` loads every `ui/e2e/fixtures/*.json`, old ones included.
- **Spec** `e2e/quiet-end.spec.ts`:
  - Row text for both fixtures, including the gap name.
  - Summary "2 hops" and "N+ hops".
  - Destination entity present or absent in the test-hook frames.
  - Tunnel dive: last gate titled "Destination".
  - Motion trace through the `trace.done` transition passes `checkTrace` (no jump, no flicker).
  - New darwin screenshots `globe-quiet-done-1280` and `tunnel-destination` are generated locally only. Existing baselines are untouched.
- **Verify:**
  - Functional run on the Apollo browser server: `make build && cd ui && PW_TEST_CONNECT_WS_ENDPOINT=ws://10.0.2.13:3000/ PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' npx playwright test e2e/quiet-end.spec.ts --workers=4`
  - Baselines, as a background job: `heavy npx playwright test e2e/quiet-end.spec.ts --update-snapshots --project=chromium --project=webkit`

### 9. Integration gate
- `make test`, the full remote E2E run, and `heavy make e2e-local`.
- Real traces to 74.101.2.152 (expect `quiet`, unreachable, "2 hops") and google.com (expect `reached`, unchanged).
- A windowed motion capture of the `quiet-reachable` replay at native pixels.

## Concurrency (call out in review: `review.concurrency`)
1. **Quiet stop versus user cancel.** Both cancel the process. The runner checks the caller's `ctx` after `Wait`, so a user cancel always wins and no `trace.done` is sent.
2. **Events after the stop.** After `stopProc` the parser can still flush a padded hop at EOF. The runner discards everything after the 5th quiet hop, and still drains `parsed` so the parser goroutine is joined.
3. **The early stop never cancels live's `ctx`.** Enrichment of the last hops and the destination work finish, and `trace.done` follows every update.
4. **Dialer goroutine.** `DialContext` runs under per-attempt contexts derived from the trace context, so a cancel aborts the in-flight dial. `drain` joins it before `Trace` returns, preserving the "nothing emitted after `Trace` returns" guarantee.
5. **Only the trace goroutine emits.** `collect` writes local state under a mutex and never calls `emit`. Readers wait for `destWait` (WaitGroup gives the happens-before).
6. **Bounded waits.** Worst case for the destination check is about 8 s (443 times out, then 3 connects on 80). It starts at the header, far earlier than the 5 quiet hops (at least 75 s on macOS defaults), so it never delays `done` in practice.

## Decisions the spec left open (recommendation in each)
- **D1 Optional fields:** use an `lp:"optional"` struct tag. Absent is allowed; null is rejected on both sides.
- **D2 `error`/`cancelled`:** keep them in the enum but never send them on the wire. Errors stay `error` messages and a cancel stays silent, as today. The reducer records them in `endReason`.
- **D3 Versioning:** use code constants plus a cross-check test, not a wire field. Fixture format stays v1.
- **D4 Destination enrichment:** send it inside `trace.done`, produced by the existing `Enricher` through a collecting emit. No new message type.
- **D5 `limit`:** any finish with hops that is neither reached nor quiet, including traceroute exiting early on `!H`.
- **D6 Connects:** sequential. The first success locks the port; failures after the first success are ignored.
- **D7 "N+":** N = hops through the last reply + 1 (Brooklyn case: "3+ hops"). The network count and delay in the summary stay as today.
- **D8 Status tail** ("· reached / · not reached"): for quiet with a reachable destination, show "· destination answers". For quiet and unreachable, keep "· not reached".
- **D9 Scene:** add the destination after the trailing quiet hops rather than replacing them. No node is removed, so no visibility flicker. A destination with no geo gets no arc or gate; the list row still shows.
- **D10 Estimated gate:** reuse the globe's estimated treatment (0.6 alpha plus shimmer, no shimmer under reduced motion).
- **D11 Closing-row place:** use `placeLabel` of the last responding hop. That can read "Your router · Brooklyn".
- **D12 Destination row:** expandable details. Clicking focuses the destination entry when the scene has one.
