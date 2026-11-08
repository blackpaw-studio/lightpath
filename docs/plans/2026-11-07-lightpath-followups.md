# Lightpath — review follow-ups routed to later steps

Orchestrator's tracking list. Each item says where it gets resolved.

- **M0 review P2 #1–3 (protocol strictness)** → integration S1.15 brief:
  - Go `DecodeServer` must reject missing fields, bad enum values and mistyped `hop.update` values, matching the TS rejection cases.
  - `NewHopUpdate` must reject unknown keys.
  - TS validators should use `satisfies Record<keyof …>`.
- **M0 review P2 #4 (stale assets)** → S1.15:
  - Set Vite `emptyOutDir: true`; the build script recreates `dist/.gitkeep`.
- **M0 review P2 #5 (`./...` reaches node_modules)** → S1.15:
  - CI uses the explicit package list (`./cmd/... ./internal/... ./ui` or `$(GO_PKGS)`).
- **M2-E review #2 (screen-space-only jump check)** → tunnel lane G brief:
  - Add world/depth position to `EntityFrame` and a `maxJumpWorld` check.
- **M2-E review #4 (hops moving mid-stream)** → globe lane F follow-up, plus M3:
  - A late `hop.update` geo, or re-estimation, moves nodes. These moves must tween, never snap.
  - E2E records frames while hops stream in, not only during dive/surface.
- **M2-H review #1 (scene reset on disconnect)** → M3 wiring:
  - When the connection goes from connected to disconnected, feed a synthetic reset or interrupted state into the reducer so the scene stops showing an active trace.
  - The HUD already handles this (429415c).
- **M2-E review #6 (no trace id)** → server/enricher security review + S1.15:
  - Drop enrichment updates once the trace ctx is cancelled.
  - The session must never emit an event from a previous trace after a new `trace.started`.
