# Plan: Lightpath friendlier first run and hop list

Spec: `docs/specs/2026-11-08-lightpath-friendlier-ux.md` (amends `docs/specs/2026-11-07-lightpath.md`). Where this plan and the spec disagree, the spec wins. Branch: `feat/friendlier-ux`.

## Root cause: the install panel shows up late
- `ui/src/hud/hud.ts:128` only shows the panel when `conn.failures > 0`.
- `failures` only goes up in `ws.onclose` (`ui/src/conn.ts:72-81`). If the first socket hangs, `onclose` never fires and the panel never shows. A pending Chrome Local Network Access prompt is one case. A browser that holds a connection to a closed loopback port is another. Nothing times out a hung dial: `dial()` (`conn.ts:55`) has no deadline, and the backoff timer only starts once the socket closes.
- If the refused case is the actual delay, then later failures are the issue: Chrome throttles repeated failing WebSocket connects to the same host, so each new dial takes longer to fail. That shows up as a slow first appearance only when the first close is slow.
- **Step 1 confirms which case it is before any fix lands.** Load the built hosted page in Chrome and WebKit with no agent running. Log the time to the first `onclose`, with and without the LNA prompt.
- Fix: the HUD needs a signal that does not wait for a close. conn sends `slow: true` once the first dial has been open `SLOW_MS = 1500` without reaching `open`, or straight away on the first close. It does **not** close the hung socket, because that could cancel a pending LNA prompt. Background retries stay as they are.

## Steps (each one starts with a failing test)

**1. Repro and timing (conn).** Files: `ui/src/conn.ts`, `ui/src/conn.test.ts`.
- `ConnState` gets `readonly slow: boolean`. It is true after the first close, or after a dial stays pending for `SLOW_MS`. It goes back to false on `open`.
- Failing Vitest test, using `vi.useFakeTimers()` and a stub socket that never opens or closes: `slow` is false at 1499 ms and true at 1500 ms.
- Second failing test: a stub that closes at 10 ms gives `slow: true` within 1 s.
- Third test: when the socket later opens, conn emits `connected` with `slow: false`, with no reload.
- The pending-dial timer is cleared on `open`, `close`, and `connection.close()`.
- Verify: `cd ui && npx vitest run src/conn.test.ts`.

**2. HUD gate on `slow`.** Files: `ui/src/hud/hud.ts:128`, `ui/src/hud/hud.test.ts:61-71`, `ui/src/app.ts:48` (initial state gets `slow: false`).
- Change the existing panel test to drive `slow` instead of `failures`. It should fail first.
- New gate: `hosted && status !== "connected" && slow`.
- Verify: `npx vitest run src/hud src/app.test.ts`.

**3. `shortNetworkName(org, asn)`.** New files: `ui/src/hud/network.ts` and `network.test.ts`.
- A curated table matched on ASN first, then on org regex. It covers the 21 names in the spec. For example, AS701/702/703 and `/uunet|verizon/i` both map to Verizon.
- Otherwise, a cleanup heuristic:
  1. Drop leading `AS\d+`-style tokens.
  2. Cut at ` - ` or `,`.
  3. Strip `Inc|LLC|Ltd|Communications|Networks|Corp` and similar suffixes.
  4. Title-case.
- Return null when nothing is left.
- Table-driven tests start red. They include `"UUNET - Verizon Business, US"` → `Verizon`, a null org with a known ASN, and junk input.

**4. Formatting helpers.** Files: `ui/src/hud/rows.ts` and `rows.test.ts`.
- `medianRtt(probes): number | null` takes the median of the non-null probes.
- `delayText(ms)` produces strings like `10 ms`.
- `isPrivateIp(ip)` covers RFC1918, CGNAT 100.64/10, link-local, loopback, IPv6 ULA and link-local.
- `isIpLiteral(s)` is used by the header to decide whether to append the IP.
- `placeLabel(hop)` returns:
  - `Your router` for hop 1 on a private IP, or `Your router · <city>` if the city is known.
  - `Local network` for other private hops.
  - `<network> · <city>` for public hops. When the location is estimated, the city gets a `≈` prefix.
- Each behaviour starts with a failing test. Verify: `npx vitest run src/hud`.

**5. Grouping (pure function).** `ui/src/hud/rows.ts`.
- `groupHops(hops): Row[]`, where `Row = {kind:"hop", hop} | {kind:"quiet", ttls}`.
- A quiet hop is one where every probe's `rttMs === null`. Consecutive quiet hops form one run.
- Each row gets a stable `key`: `h<ttl>`, or `q<firstTtl>` for a run.
- Failing tests:
  - a run of 1, and a run of 10;
  - a growing run keeps its key;
  - a late reply in the middle of a run splits it into quiet / hop / quiet with the right ttls;
  - trailing and leading runs.
- `summaryLine(state)` returns `N hops · M networks · X ms`:
  - N = `hops.length`;
  - M = distinct ASNs among public responding hops, falling back to the distinct short name when the ASN is null;
  - X = median delay of the last responding hop.
- Tests for `summaryLine` too.

**6. Row markup.** Files: `ui/src/hud/hops.ts` (rewritten) and `hops.test.ts`.
- Remove `Badge` and `badgeFor`.
- A hop row has: a dot (`.dot.solid` or `.dot.hollow`), `.place`, `.delay`, and a hidden `.details` block containing the IP, hostname, `AS<n> <full org>`, all three probe times (`rttText`), and the location source.
- A quiet row has: `.quiet`, a dashed connector, the text `N routers stayed quiet` (singular for one), the subtitle, and details that list its hop numbers.
- The row element is `role="button"` with `aria-expanded`. Enter, Space and click all toggle it.
- All text goes through `textContent`.
- Failing DOM tests for each of the above.

**7. HUD wiring.** Files: `ui/src/hud/hud.ts`, `hud.test.ts`, `styles.css`.
- Header: `To <host>`, plus ` (<ip>)` only when the target is not an IP literal, plus the status. When done, show `summaryLine`.
- The HUD keeps an `expanded: Set<key>` so expanded rows survive `replaceChildren`. Keys of rows that no longer exist are dropped.
- Focus: clicking a hop row both focuses it in the scene and toggles its details. `setFocus(ttl)` highlights the quiet row whose `ttls` contains that ttl.
- CSS: dots, dashed connector, details grid, no horizontal overflow at 375 px. Expand/collapse animation is turned off under `prefers-reduced-motion`. The attribution footer stays.
- Verify: `npx tsc --noEmit && npx eslint . && npx vitest run`.

**8. Install panel copy.** Files: `ui/src/hud/install.ts` and a new `install.test.ts`.
- New constant `RUN_CMD = "curl -fsSL https://lightpath.blackpaw.studio/run | sh"`.
- The panel shows one copyable code row and the line "Downloads a small helper and starts it. Ctrl-C to stop."
- An `Install permanently` link points to `/install.sh`. The Safari and LNA hints and the agent link stay.
- Failing test checks the text and the link.

**9. `ui/public/run.sh`.** New files: `ui/public/run.sh` and `run_test.sh`, in the style of `install_test.sh`.
- Detect/fetch/sha256 helpers are duplicated from `install.sh`, which the spec allows.
- Version resolution:
  - `LIGHTPATH_VERSION` overrides it, for tests.
  - Otherwise use curl `-fsSLI -o /dev/null -w '%{url_effective}'` on `…/releases/latest`, or wget `-S --spider` and parse `Location`.
  - The tag must match `^v[0-9]+(\.[0-9]+){2}$`, otherwise `die`. This stops path injection into the cache directory.
- Download from `$LIGHTPATH_RELEASES_URL/download/$version/$name`.
- Cache path: `${XDG_CACHE_HOME:-$HOME/.cache}/lightpath/$version/lightpath`.
- Reuse the cached file if it is a regular file (`-f`), is not a symlink (`! -L`), and is executable (`-x`).
- Otherwise:
  1. Download into a private mktemp directory and verify the checksum.
  2. Stage with `mktemp -d` inside the cache parent.
  3. `mv` into place.
- Print `Running lightpath <version> · Ctrl-C to stop`, then `exec "$bin" --no-open`. The agent already has `--no-open` (`cmd/lightpath/main_test.go:72`).
- Write the tests first, with stubbed `uname` and `curl` on PATH and `file://` fixtures:
  - first run downloads, verifies and execs, with the fake binary echoing its arguments;
  - second run reuses the cache without fetching (the stubbed fetch fails if it is called);
  - checksum mismatch → non-zero exit, nothing cached;
  - unsupported OS or arch;
  - malformed tag rejected;
  - a pre-planted symlink at the cache path is not trusted.
- Verify: `sh run_test.sh && shellcheck run_test.sh ui/public/run.sh`.

**10. Pages routing and CI.** Files: `ui/public/_redirects` (new), `ui/public/_headers`, `Makefile` (`install-test`), `.github/workflows/ci.yml` (`install-script` job).
- `_redirects`: `/run /run.sh 200`.
- `_headers`: add `/run` and `/run.sh` blocks with `Cache-Control: public, max-age=300` and `Content-Type: text/plain; charset=utf-8`.
- Verify: `make install-test`. Then, on wrangler: `npx wrangler pages dev ui/dist` and run `curl -sI localhost:8788/run` to check for a 200, `text/plain`, and the body of run.sh.

**11. E2E updates.** Files: `ui/e2e/hop-fields.spec.ts`, `responsive.spec.ts`, `install.spec.ts`, `stream.spec.ts`.
- **hop-fields:** expand each row, then assert IP, host, ASN/org, all three times and source in `.details`. Assert hollow and solid dots in place of the old badges.
- **responsive:** row count becomes the grouped count from the real fixture. Expanded rows still don't overflow at 375 px.
- **install:** assert `RUN_CMD` and the install link. New test: a `routeWebSocket` that never closes still shows the panel within 1.5 s (`toBeVisible({timeout: 2000})` after `goto`).
- **stream:** `.hop` count becomes the grouped row count.
- Verify:
  - `make e2e` (remote Chromium and WebKit, no snapshots).
  - Baselines: `heavy make e2e-local -- --update-snapshots`, run locally on darwin only. Evan reviews the new PNGs before commit.

**12. Integration gate.** `make test`, `make install-test`, `make e2e`, then one `heavy make e2e-local`.

## Cloudflare Pages: serving `/run` as text/plain
- **Recommendation:** keep the `run.sh` source and add a `_redirects` 200 rewrite, with `_headers` rules keyed to **both** `/run` and `/run.sh`.
- Cloudflare applies redirects before headers. I couldn't confirm from the docs whether `_headers` matches the request path or the rewrite target after a 200 rewrite. Covering both paths means it doesn't matter.
- An extensionless `public/run` file would also work, but it loses the `.sh` name that shellcheck and editors pick up, and the spec names `run.sh`.
- Check after deploy: `curl -sI https://lightpath.blackpaw.studio/run` shows `text/plain`.

## Decisions the spec didn't settle (recommendation given)
1. **`SLOW_MS` = 1500.** The hung socket is not closed, so the LNA prompt survives.
2. **Delay rounding:** whole ms; `<1 ms` below 0.5.
3. **"M networks":** distinct ASNs among public responding hops, with the short name as fallback. Private hops are not counted.
4. **Row text when there's no city or network:** network only, or city only. With neither, show the IP.
5. **Quiet rows:** expand only. Scene focus maps onto them, but clicking one does not move the scene.
6. **Click on a hop row** both focuses the scene and toggles the details.
7. **run.sh cache trust:** a regular file, not a symlink, executable. Not re-verified, as the spec says. Old version directories are not pruned.
8. **run.sh does not repeat install.sh's traceroute warning.** The agent already reports `traceroute_missing`.

Sources:
- [Cloudflare Pages: Redirects](https://developers.cloudflare.com/pages/configuration/redirects/index.md)
- [Cloudflare Pages: Headers](https://developers.cloudflare.com/pages/configuration/headers/index.md)
