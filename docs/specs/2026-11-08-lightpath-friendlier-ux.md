# Lightpath — friendlier first run and hop list

Approved by Evan 2026-11-08. Amends docs/specs/2026-11-07-lightpath.md; that spec still governs everything not named here.

## 1. Install panel appears promptly
- Hosted page (no agent reachable): the install panel is visible ≤ 1 s after the first failed connection attempt (or ≤ 1.5 s after load if the attempt hangs, e.g. a pending Chrome Local Network Access prompt). No waiting for a retry/backoff series.
- Reconnect attempts continue in the background; when the agent answers, the panel hides and the normal view appears with no reload.
- Find and fix the root cause of the current delay; a reducer/conn unit test with fake timers pins the timing.

## 2. One command to run, no install
- New `ui/public/run.sh`, served at `https://lightpath.blackpaw.studio/run` (Pages `_headers`: `text/plain`, short cache, same as install.sh; add a `/run` → `/run.sh` mapping via `_redirects` 200 rewrite or serve the file as `/run`).
- Usage: `curl -fsSL https://lightpath.blackpaw.studio/run | sh`.
- Behaviour: detect OS/arch like install.sh (share code by keeping both POSIX and small; duplication of the detect/verify helpers is acceptable if extracting is awkward for a curl-piped script). Resolve the latest release version, cache the binary at `${XDG_CACHE_HOME:-$HOME/.cache}/lightpath/<version>/lightpath`, sha256-verify against `checksums.txt` on download, reuse the cached binary on later runs (re-verify not required), then `exec` it with `--no-open` (the user is already on the page). Print one line before exec: what's running and "Ctrl-C to stop".
- Same safety bar as install.sh: private mktemp staging, atomic move into the cache, no shell eval of downloaded content, fails clearly on unsupported OS/arch or checksum mismatch. Tests in install_test.sh style (or run_test.sh) + shellcheck; wired into `make install-test` and CI.
- Install panel shows only the run command with a copy button and one line ("Downloads a small helper and starts it. Ctrl-C to stop."). `install.sh` stays, linked as a small "Install permanently" text link. Keep the existing Safari / LNA hints.

## 3. Friendlier hop list (HUD only; globe and tunnel unchanged)
- Header: destination shown once (`To <host>`; append the IP only if the input was a hostname) plus status; when done, a plain summary `N hops · M networks · X ms` (X = final hop's typical delay).
- Row (responding hop): primary text = place + short network name, e.g. `Verizon · New York`. Hop 1 with a private IP → `Your router` (+ place if known); other private hops → `Local network`. One delay figure = median of the replies, e.g. `10 ms`.
- Location confidence: solid dot = measured location (api/hostname/local); hollow dot + `≈` before the place = estimated. Remove the MEASURED / ESTIMATED badges.
- Short network name: pure function `shortNetworkName(org, asn)` in its own module: a curated table for well-known carriers/clouds (Verizon, Comcast, AT&T, Lumen/Level 3, Cogent, Charter/Spectrum, Cox, Google, Cloudflare, Amazon, Microsoft, Akamai, Fastly, Hurricane Electric, NTT, Telia/Arelion, Zayo, GTT, Tata, Meta, Apple) matched on org text/ASN, else a cleanup heuristic (drop leading ASN-ish tokens, cut at " - " or ",", strip suffixes like Inc/LLC/Ltd/Communications/Networks, title-case). Unit-tested, including the observed "UUNET - Verizon Business, US" → "Verizon".
- Silent hops: a run of ≥ 1 consecutive non-responding hops collapses to one quiet row with a dashed connector: `10 routers stayed quiet` / `1 router stayed quiet`, subtitle "Many networks hide their routers; the path continues." A run that is still growing updates in place; a later reply for a hop in the run splits the run correctly. Grouping is a pure, unit-tested function over the hop list.
- Details on tap/click (and keyboard: Enter/Space, aria-expanded): the row expands to show IP, hostname, AS number + full org, all three probe times, and location source. Quiet rows expand to list their hop numbers.
- Keep the existing hop-selection ↔ scene focus behaviour, 375 px layout without horizontal overflow, reduced-motion behaviour, and the attribution footer.
- Update affected E2E specs (hop-fields, responsive, install, stream) to the new structure; keep their intent. Screenshot baselines will change: regenerate local darwin baselines only (not on Apollo).

## Out of scope
Windows support, globe/tunnel label changes, the speed-of-light check, panel-aware framing.
