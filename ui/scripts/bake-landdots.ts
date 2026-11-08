// Bakes src/assets/landdots.bin: a Fibonacci lattice of points on the sphere,
// kept where they fall on Natural Earth 1:110m land (public domain).
//
//   node scripts/bake-landdots.ts [--src ne_110m_land.geojson] [--points 60000]
//
// Without --src the GeoJSON is downloaded from the Natural Earth vector repo.
// Only the baked .bin is committed.
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { encodeLandDots, fibonacciLattice, inLand, type LandPolygon, type LonLat } from "../src/scene/landgrid.ts";

const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_land.geojson";
const OUT = fileURLToPath(new URL("../src/assets/landdots.bin", import.meta.url));

const isLonLat = (v: unknown): v is LonLat =>
  Array.isArray(v) && v.length >= 2 && v.slice(0, 2).every((x) => typeof x === "number" && Number.isFinite(x));
const isRing = (v: unknown): v is LonLat[] => Array.isArray(v) && v.length >= 4 && v.every(isLonLat);
const isPolygon = (v: unknown): v is LandPolygon => Array.isArray(v) && v.length > 0 && v.every(isRing);

/** Validates untrusted GeoJSON and flattens Polygon/MultiPolygon features. */
const polygonsOf = (json: unknown): LandPolygon[] => {
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) throw new Error("GeoJSON: missing features array");
  return features.flatMap((f: unknown) => {
    const g = (f as { geometry?: { type?: unknown; coordinates?: unknown } }).geometry;
    if (g?.type === "Polygon" && isPolygon(g.coordinates)) return [g.coordinates];
    if (g?.type === "MultiPolygon" && Array.isArray(g.coordinates) && g.coordinates.every(isPolygon)) {
      return g.coordinates as LandPolygon[];
    }
    throw new Error(`GeoJSON: unsupported geometry ${String(g?.type)}`);
  });
};

const load = async (src: string | undefined): Promise<unknown> => {
  if (src) return JSON.parse(await readFile(src, "utf8"));
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  return res.json();
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { src: { type: "string" }, points: { type: "string", default: "60000" } } });
  const n = Number(values.points);
  if (!Number.isInteger(n) || n < 1000 || n > 500000) throw new Error(`--points must be an integer in [1000, 500000]`);
  const polygons = polygonsOf(await load(values.src));
  const land = fibonacciLattice(n).filter(([lat, lon]) => inLand(lat, lon, polygons));
  const buf = encodeLandDots(land);
  await writeFile(OUT, new Uint8Array(buf));
  process.stdout.write(`${polygons.length} polygons, ${land.length}/${n} dots on land → ${OUT} (${buf.byteLength} B)\n`);
};

main().catch((err: unknown) => {
  process.stderr.write(`bake-landdots: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
