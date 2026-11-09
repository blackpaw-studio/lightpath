# Lightpath — estimated destination, panel-aware framing, speed-of-light check

Approved by Evan 2026-11-09 (in conversation). Amends the 2026-11-07 and both 2026-11-08 specs; they govern everything not named here.

## 1. Place a destination that doesn't answer
- Today a `quiet` finish whose destination isn't reachable ends with "The destination doesn't answer traces". The agent already sends that destination's enrichment (location, ASN, org) in `trace.done`.
- New: when the unreachable destination has a location, treat it like the reachable case but estimated throughout.
  - The final row reads "Destination · <network> · ≈ <place>" with the note "Doesn't answer traces; the last stretch is estimated from its IP location." There is no delay figure.
  - The globe draws the dashed arc to it, and the tunnel adds the final estimated gate, exactly as for a reachable destination.
  - The summary reads `N+ hops`.
- When the destination has no location, the current closing row stays as it is.
- Do not claim the destination is a home connection; we can't know that.

## 2. Keep the path clear of the HUD panel (globe framing)
- Problem: while tracing, the camera frames the path tight, and the origin can sit behind the left HUD panel.
- The framing must treat the area covered by HUD panels as unavailable. Fit the path's projected extent, with a margin, into the visible region: the viewport minus the panel's bounding rect, measured from the DOM and updated on resize and panel size changes.
  - On wide screens the panel is a left column, so the framing centre shifts right.
  - At 375 px the panel is a bottom or top sheet, so the framing centre shifts vertically.
- Keep the existing camera spring, the glide cap and reduced-motion behaviour. A change in the panel rect re-targets the spring smoothly, with no jump.
- Invariant (added to the E2E motion checks): during and after a trace, every drawn hop node's screen position lies outside the panel rect.

## 3. Speed-of-light location check
- A reply can't come from farther away than light in fibre can travel and return. Use roughly 100 km per ms of RTT (200 km/ms one way, halved for the round trip).
- For each hop with a measured location (source `api` or `hostname`), compare its great-circle distance from the origin with `100 km × minRTT + SLACK`.
  - The origin is the user's location: hop 1, or the agent's local location.
  - `SLACK` is 500 km, which absorbs geo-IP error at the origin.
  - If the distance exceeds that limit, the hop's location is implausible. Drop it and re-estimate the hop like any hop without a location, so it shows a hollow dot and "≈".
- The expanded details say why: "IP database says Brisbane, AU, but a 10 ms reply can't come from that far."
- The same check applies to the destination, using its TCP delay when reachable.
- The check is a pure, unit-tested function in the UI (data stays as the agent sends it). It covers the observed case: 1.1.1.1 placed in Brisbane at about 10 ms from New York becomes an estimate.
- A hop with no RTT, or no origin location, is left unchanged.

## Testing
- Unit tests:
  - the plausibility function, including boundaries, missing data, and the Brisbane case;
  - the unreachable-destination rows;
  - the framing math: fitting into the visible rect for both left-column and sheet layouts.
- E2E:
  - the firewalled fixture gains a destination location, so the estimated arc and gate render;
  - the panel-clearance invariant at 1280×720 and 375×812;
  - a fixture hop with an implausible location shows as estimated.
- Local darwin baselines only. Expect the existing globe baselines to change because of the framing; regenerate them locally and show them to Evan.

## Out of scope
Detecting residential connections; any change to the agent.
