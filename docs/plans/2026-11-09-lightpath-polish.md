# Lightpath polish — implementation plan

Spec: `docs/specs/2026-11-09-lightpath-polish.md` (wins any conflict with this plan). UI only, no agent changes. Every step is test-first, unless the step says otherwise.
Commands run from `ui/`. Unit: `npx vitest run <file>`. E2E (Playwright 1.64.1, remote browsers): `PW_TEST_CONNECT_WS_ENDPOINT=ws://10.0.2.13:3000/ PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' npx playwright test <spec> --workers=4`. Local darwin runs (needed for baselines) go through `heavy`.

## Architecture decisions

**One "estimated" source (§1, §3).** The reducer stays a faithful copy of what the agent sends. A new pure module `src/plausibility.ts` exports `checkLocations(state: TraceState): ShownState`. `ShownState` is `TraceState` plus `doubts: ReadonlyMap<number, LocationDoubt>` (keyed by ttl) and `destinationDoubt: LocationDoubt | null`, where `LocationDoubt = { place: string | null; rttMs: number }`. When a hop or destination fails the check, its copy has `lat`, `lon` and `city` set to null and `geoSource: "estimated"`.
- The controller (`app.ts`) memoises one derived value per reducer state. `createController` gets a new dep `derive = checkLocations`. It passes `shown` to both `hud.render` and `scene.setState`.
- `HudLike.render` and `SceneLike.setState` take `ShownState`. `controller.state()` and the test hook keep returning the raw state.
- So `layout.ts` (`located()`), `rows.ts`, `tunnelLayout.ts` and `sceneDestination` all see one estimated result without knowing the check exists.

**Panel rect into framing (§2): injected, no globals.**
- `hud.ts` adds `observeOcclusion(cb: (rects: readonly Rect[]) => void): () => void`, built from `ResizeObserver` on each visible `.panel` plus `resize`. It reports viewport-relative CSS-pixel rects.
- `main.ts` wires `hud.observeOcclusion(view.setOcclusion)`. The chain is `SceneView.setOcclusion` → `GlobeView.setOcclusion` → `CameraRig.setSafeRect(rect, viewport)`.
- A pure `safeRect(viewport, panels): Rect` in a new `scene/safeArea.ts` classifies each panel by the edge it hugs:
  - a left column (narrower than 60% of the viewport) moves the left edge;
  - a full-width panel cuts from the top or bottom, by its centre y.
- At 375 px the top form and the bottom sheet both cut, which leaves the band between them.

**Framing math (§2, §4).** This is pure, in `camera.ts`. The safe rect's centre `c` and half extents `(hx, hy)` are in NDC.
- **Off-axis projection.** The camera still looks at the globe centre. `rig.apply()` shifts the projection: after `updateProjectionMatrix`, set `projectionMatrix.elements[8] = -cx` and `[9] = -cy`, then update the inverse. The axis then projects to `c`, and `project()` and testhooks pick it up for free.
- **Springs.** `cx` and `cy` get their own critically damped springs, beside `dir` and `dist`. A rect change re-targets them smoothly, with no jump. Reduced-motion cuts set them instantly along with everything else.
- **Fit.** New `fitInRect(points, dir, aspect, fov, rect): number | null`. For each point p, let `f = p·dir`, `r = |p·right|` and `u = |p·up|`. Then `d ≥ f + r/(tan(hHalf)·hx·M)` and `d ≥ f + u/(tan(vHalf)·hy·M)`, where `M = FIT_MARGIN`.
  - Hemisphere: `f > 0` and `d ≥ 1/f + ε`, so p faces the camera.
  - It returns null when some `f ≤ 0` or the required `d > MAX_DISTANCE`.
- **Too-wide fallback.** `dir = slerp(first, last, 0.5)`, the great-circle midpoint of the origin and the final drawn node, at `MAX_DISTANCE`. For an exactly antipodal pair, use `capCentre`.
- **Order.** The `ELEVATION` nudge and `clampLatitude(50°)` apply first. The fit then runs against the final `dir`.
- **Bug found while reading.** Today `fitDistance` clamps angles over 90° "as the limb". That is why a back-side hop "ran off the bottom" and Moscow sat at the limb. `fitInRect` replaces it.
- **framingKey** becomes a hash of all node positions (to 3 dp) plus the safe rect, not just the last hop. The whole path then always drives the framing (§4).
- **Reduced motion** (`applyFraming`) holds still only while every drawn node is inside the safe rect, not just the newest one.

**Long-arc wobble: hypothesis (§5).**
- `writeArcPoints` gives each hop→hop arc its own hump, height `k·θᵢ·sin(πt)`.
- `estimatePosition` puts a run of estimated hops on one great circle between two anchors. The South Atlantic → Moscow stretch is likely such a run, seeded by an implausible geo hop.
- So the visible "arc" is several adjacent humps, a scalloped curve. Near the limb it is seen in profile, and that profile is the wobble.
- Each single arc's profile is already unimodal, so a test on one arc can't catch it.
- Second suspect, if the diagnostic refutes the first: depth test of the screen-space `LineSegments2` quads against the globe body (r 0.985) at the limb.

## Steps

**0. Diagnose the wobble before any fix.** Built on step 7's fixture (do that fixture first). Script a debug run of the long-haul fixture. Dump `arcInfos` and poses after done, and confirm whether the wobbly stretch spans more than one arc. Record which hypothesis holds in the commit message. If it is the second one, toggle `depthTest` on arc materials and compare screenshots before going on to step 5.

**1. Network names (§6).** File: `hud/network.ts`.
- Failing tests in `network.test.ts`:
  - `"PCCWG-APAC-HK - PCCW Global, Inc., HK"` → `"PCCW Global"`;
  - `"YANDEX - YANDEX LLC, RU"` → `"Yandex"`.
- `clean()`: take the text after the first `" - "` when it is non-empty, else the handle. Then cut at the first `","` or `"("`, then drop the leading `AS\d+` and the corporate suffixes as today. KNOWN matching on the full string and on ASN stays first and unchanged.
- Add `{ name: "PCCW Global", asns: [3491], org: /\bpccw\b/i }`. The table is required: title-casing would turn "PCCW" into "Pccw".
- Verify: `npx vitest run src/hud/network.test.ts src/hud/rows.test.ts`. Report any existing non-table expectation that changes.

**2. Plausibility function (§3).** New `src/plausibility.ts` and test. Exports:
- `isPlausible(originPos, pos, minRttMs): boolean`;
- `checkLocations(state): ShownState`;
- `KM_PER_MS_RTT = 100`, `SLACK_KM = 500`, `EARTH_KM = 6371`.

Rules:
- Origin: `state.origin` lat/lon, else hop 1 with measured geo. With no origin, the state passes through unchanged.
- The check covers only hops whose `geoSource` is `api` or `hostname`. A hop's RTT is the minimum non-null probe RTT; with none, the hop is unchanged.
- The destination uses `rttMs` and only when reachable.

Failing tests:
- the Brisbane case (origin Brooklyn, 1.1.1.1 Brisbane, 10 ms → doubted);
- boundary at exactly `100·rtt + 500` km (passes) and 1 km past it (fails);
- no RTT, no origin, `local` geo source;
- destination reachable or unreachable;
- input not mutated.

Verify: `npx vitest run src/plausibility.test.ts`.

**3. Single source wiring and copy (§3).** Files: `app.ts` (the `derive` dep plus memo), `hud/hud.ts`, `hud/hops.ts`, `scene/sceneView.ts`, `scene/globe.ts` (types only).
- Failing tests:
  - `app.test.ts`: the HUD and the scene fakes receive the same derived object, and a doubted hop arrives as estimated in both;
  - `hops.test.ts`: the Location detail reads "IP database says Brisbane, AU, but a 10 ms reply can't come from that far.", with a hollow dot.
- Verify: `npx vitest run src/app.test.ts src/hud`.

**4. Estimated unreachable destination (§1).** Files: `destination.ts`, `hud/rows.ts`, `hud/hops.ts`.
- `sceneDestination`: quiet, done, and has lat/lon, whether reachable or not.
- `buildRows`: a destination row when the destination is reachable or located. The row gains `answers: boolean`.
- `destinationRowEl`: when unreachable, the note is "Doesn't answer traces; the last stretch is estimated from its IP location." with no delay and no "Reached via".
- `summaryLine`: `beyond` also covers a located unreachable destination.
- Failing tests:
  - `rows.test.ts`: unreachable plus located gives a destination row and `N+ hops`; unreachable without a location gives the unchanged end row;
  - `hops.test.ts`: the copy above;
  - `tunnelLayout.test.ts`: an estimated last gate with no delay;
  - `layout`: the destination joins the anchors.
- Verify: `npx vitest run src/destination.test.ts src/hud src/scene/tunnelLayout.test.ts src/scene/layout.test.ts`.

**5. Smooth long arcs (§5)** (assuming step 0 confirms the scalloping). Files: `scene/arcGeometry.ts`, `scene/arcs.ts`, `scene/globe.ts` (`arcInfos`).
- Failing test in `arcGeometry.test.ts`, named "a run of estimated hops on one great circle has one altitude hump": sample radius along the chained arcs for 6 evenly spaced hops from (−30, −20) to Moscow. It is unimodal, and its minimum is ≥ 1.
- Property test: single arcs for θ ∈ {0.01 … π−1e-4}, near-antipodal included, are unimodal, never under the surface, and have a maximum turning angle between segments under 5°.
- Fix:
  - `writeArcPoints` takes an optional span `{t0, t1, spanTheta}` and computes `r = blend·(1 + k·spanTheta·sin(π(t0 + t(t1−t0))))`.
  - `arcInfos` groups maximal runs whose interior nodes are estimated. `t0` and `t1` are the ttl fractions, the same ones `estimatePosition` uses.
  - `arcs.ts` computes `spanTheta` from the run's anchor poses every frame, so a glide stays continuous.
- Verify: `npx vitest run src/scene/arcGeometry.test.ts src/scene/arcs.test.ts src/scene/globeInfos.test.ts`.

**6. Framing math and rig (§2, §4).** Files: `scene/safeArea.ts` (new), `scene/camera.ts`, `scene/globe.ts`, `scene/sceneView.ts`, `hud/hud.ts`, `main.ts`.
- Failing tests:
  - `safeArea.test.ts`: left column at 1280×720; top and bottom sheets at 375×812; no panels.
  - `camera.test.ts`, `fitInRect`:
    - left-column rect: every point's projection (through the shifted matrix) lies inside the rect with the margin, and the centre is right of the viewport centre;
    - sheet rect: the centre moves vertically;
    - a point past 90° makes the plain fit return null, and the fallback puts both ends on the camera-facing side;
    - NY→Moscow fits.
  - `camera.test.ts`, rig: `setSafeRect` re-targets the offset springs with no per-frame jump over the motion budget, and the glide cap is unchanged.
- Verify: `npx vitest run src/scene/camera.test.ts src/scene/safeArea.test.ts src/hud/hud.test.ts`.

**7. Fixtures.** No TDD: these are data.
- `quiet-firewalled.json`: the destination gains lat/lon/city (`geoSource: "api"`).
- New `long-haul-moscow.json`:
  - Brooklyn origin, Verizon in NY, transatlantic via London, Frankfurt and Stockholm (Arelion), a PCCW-org hop, and a quiet run;
  - one hop placed in Brisbane at 10 ms (the §3 E2E case);
  - reached at Yandex, Moscow, org `"YANDEX - YANDEX LLC, RU"`, AS13238.
- Register it in `e2e/agents.ts` (`FIXTURES.longHaul`) and in `playwright.config.ts`. Update `fixtureHops.ts` expectations.

**8. E2E invariants.**
- `harness.ts` adds:
  - `panelRects(page)` (DOM);
  - `expectClearOfPanels(frames, rects)`: every visible node entity's (x, y) is outside every rect;
  - `expectFacingAndSafe(page)`: after done, every node's world position · camera dir > 1/|cam| and lies inside the safe rect (expose the camera position and safe rect through test hooks).
- Tests:
  - `globe.spec.ts`: panel clearance at 1280×720 and 375×812, during and after the trace;
  - new `long-haul.spec.ts`:
    - facing and safe after done, for real-macos and long-haul;
    - the Brisbane hop's row has a hollow dot and the doubt text;
    - PCCW and Yandex names;
  - `quiet-end.spec.ts`: the firewalled test now expects the destination row, the estimated arc and the final gate;
  - `transition.spec.ts`: keep it green, since the offset blends out.
- Verify: the remote E2E command on these specs.

**9. Baselines.** Regenerate the darwin baselines locally under `heavy` (`npx playwright test --update-snapshots` scoped to globe, quiet-end, tunnel and long-haul). Return the PNG paths to the orchestrator, which posts them to Evan. Nothing is regenerated against the remote server.

**10. Integration gate.** `npm run typecheck && npm run lint && npm test`, then the full E2E (remote, plus local darwin screenshots under `heavy` once).

## Decisions the spec left open (with recommendations)

1. **The "≈" label for a doubted hop.** No re-estimated position has a place name. Recommend the row show "<network> · ≈" with a hollow dot and the reason in the details. The alternative is to borrow a neighbour's city, which would be invented.
2. **The origin for the check.** Recommend `state.origin`, then hop 1, the same order `layout.ts` uses.
3. **Panel clearance while a hop appears.** The spring lags a new hop. Recommend enforcing it on every frame, with a grace of one `APPEAR_MS` (400 ms) after each node is born. Fail the test outright if the zoom-out boost can't meet that.
4. **Projection offset in the tunnel.** The tunnel controller drives `camera.fov` and the pose. Recommend scaling the offset by `1 − viewT`, so it is zero inside the tunnel and continuous through dive and surface.
5. **Multiple panels.** Recommend reducing them to one safe rect using the edge classification above, not true free-region geometry.
6. **The fallback midpoint.** Recommend the origin to the last drawn node, which is the destination when there is one.
