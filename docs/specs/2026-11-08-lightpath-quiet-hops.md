# Lightpath — ending the path cleanly and naming quiet hops

Approved by Evan 2026-11-08. Amends docs/specs/2026-11-07-lightpath.md and 2026-11-08-lightpath-friendlier-ux.md; those govern everything not named here.

## Problem
When the destination drops probes (firewalled hosts, many residential IPs), traceroute keeps probing to hop 30 and the list fills with "routers stayed quiet" rows that are not routers at all. Measured 2026-11-08 from Brooklyn: 74.101.2.152 answers neither UDP, ICMP traceroute nor ping; only hops 1–2 respond. Normal targets (google.com, 1.1.1.1) have ≤ 1 silent hop.

## 1. Stop at the end of the path (agent)
- Destination check: when a trace starts, the agent also opens a TCP connection to the destination on 443, falling back to 80 (connect only, closed immediately; no data sent). Each attempt has a 2 s timeout; take the best of up to 3 successful connects as its delay. No root needed. Result: reachable (port, delay) or not reachable.
- Early stop: once the trace has had at least one responding hop and then QUIET_LIMIT = 5 consecutive hops with no reply to any probe, the agent stops traceroute (same cancellation path as a user cancel, but reported as a normal finish).
- The finish reports why it ended: `reached` (a hop is the destination), `quiet` (early stop), `limit` (max hops), `error`, or `cancelled`. It also carries the destination-check result.
- Destination location and network: the destination IP goes through the same enrichment (location, ASN, name) as hops.
- Protocol changes are additive and versioned in Go and TS together, with golden testdata updated; old fixtures still replay.

## 2. Show the end honestly (UI)
- `quiet` finish, destination reachable by TCP: the trailing quiet run (the 5 probes) is replaced by a final row "Destination · <network> · <place> · <delay>" with a note "Answers directly; routers near it stay quiet." On the globe, a dashed arc runs from the last responding hop to the destination; in the tunnel it is the last gate, styled as estimated. The summary hop count reads `N+ hops`.
- `quiet` finish, destination not reachable: the trailing run becomes one closing row: "The destination doesn't answer traces" / "The path ends somewhere past <last network> · <last place>." No arc to the destination.
- `reached` and `limit` finishes look as they do today.

## 3. Name the gaps (UI)
A quiet run between two responding hops is named by its neighbours, using `shortNetworkName`:
- Same network on both sides: "4 routers inside Verizon's network".
- Different networks: "3 routers between Verizon and Cloudflare".
- Unknown network on either side: the current copy ("N routers stayed quiet").
The expanded details still list the hop numbers. Globe and tunnel drawing of quiet hops is unchanged (estimated positions with a smooth glide).

## Testing
- Go: early-stop logic driven by scripted traceroute output (no real network). Destination check against a local listener and a closed port, with an injected dialer/clock.
- TS: run naming (same / different / unknown neighbours), destination-row rendering for both `quiet` cases, the `N+` summary.
- Replay fixtures: a firewalled destination (quiet finish, unreachable) and a quiet run before a reachable destination; E2E specs cover both. Local darwin baselines only.

## Out of scope
Retrying silent hops with other probe types, TCP traceroute (needs root), Windows.
