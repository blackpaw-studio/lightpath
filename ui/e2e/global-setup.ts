// The replay agents serve the UI embedded in ../lightpath at build time, so a
// stale binary silently tests old code. Fail fast instead.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const UI = join(import.meta.dirname, "..");
const BIN = join(UI, "..", "lightpath");
const DIST_INDEX = join(UI, "dist", "index.html");

const newest = (path: string): number => {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  return readdirSync(path).reduce((m, name) => Math.max(m, newest(join(path, name))), st.mtimeMs);
};

export default function globalSetup(): void {
  const hint = "run `make build` from the repo root (or `make e2e`)";
  if (!existsSync(BIN) || !existsSync(DIST_INDEX)) throw new Error(`no agent binary or UI build: ${hint}`);
  const sources = Math.max(newest(join(UI, "src")), newest(join(UI, "index.html")));
  if (sources > statSync(DIST_INDEX).mtimeMs) throw new Error(`ui/src is newer than ui/dist: ${hint}`);
  if (statSync(DIST_INDEX).mtimeMs > statSync(BIN).mtimeMs) throw new Error(`ui/dist is newer than the agent binary: ${hint}`);
}
