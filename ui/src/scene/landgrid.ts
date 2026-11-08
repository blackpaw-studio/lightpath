// Pure land-dot helpers shared by scripts/bake-landdots.ts (Node) and the
// runtime decoder. No imports, so Node can run the bake script directly.

/** [lon, lat] in degrees, GeoJSON order. */
export type LonLat = readonly [number, number];
/** A polygon: outer ring first, then holes (GeoJSON Polygon coordinates). */
export type LandPolygon = readonly (readonly LonLat[])[];

const GOLDEN_ANGLE_DEG = 180 * (3 - Math.sqrt(5));
const LAT_SCALE = 32767 / 90;
const LON_SCALE = 32767 / 180;

const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/** n points [lat, lon] (degrees) evenly spread by area on the sphere. */
export const fibonacciLattice = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const z = 1 - (2 * (i + 0.5)) / n;
    return [(Math.asin(z) * 180) / Math.PI, wrapLon(i * GOLDEN_ANGLE_DEG)];
  });

/** Even-odd ray cast in lon/lat space. */
const inRing = (lon: number, lat: number, ring: readonly LonLat[]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** True when (lat, lon) lies inside any polygon's outer ring and none of its holes. */
export const inLand = (lat: number, lon: number, polygons: readonly LandPolygon[]): boolean =>
  polygons.some((rings) => {
    const [outer, ...holes] = rings;
    return outer !== undefined && inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h));
  });

/** Packs [lat, lon] pairs as little-endian Int16 pairs (4 bytes per dot). */
export const encodeLandDots = (dots: readonly (readonly [number, number])[]): ArrayBuffer => {
  const buf = new ArrayBuffer(dots.length * 4);
  const view = new DataView(buf);
  dots.forEach(([lat, lon], i) => {
    view.setInt16(i * 4, Math.round(lat * LAT_SCALE), true);
    view.setInt16(i * 4 + 2, Math.round(lon * LON_SCALE), true);
  });
  return buf;
};

/** Inverse of encodeLandDots → flat [lat0, lon0, lat1, lon1, …] in degrees. */
export const decodeLandDots = (buf: ArrayBuffer): Float32Array => {
  if (buf.byteLength % 4 !== 0) throw new Error(`landdots: ${buf.byteLength} bytes is not a whole number of dots`);
  const view = new DataView(buf);
  const out = new Float32Array(buf.byteLength / 2);
  for (let i = 0; i < out.length; i += 2) {
    out[i] = view.getInt16(i * 2, true) / LAT_SCALE;
    out[i + 1] = view.getInt16(i * 2 + 2, true) / LON_SCALE;
  }
  return out;
};
