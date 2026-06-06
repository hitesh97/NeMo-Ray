/**
 * OSGB36 ⇄ WGS84 datum conversion.
 *
 * UK Ordnance Survey data (National Grid, EPSG:27700, and the OSGB36 geodetic
 * datum EPSG:4277) is built on the Airy 1830 ellipsoid, which is offset from the
 * GRS80/WGS84 ellipsoid the web map uses by ~100+ m across the UK. In London the
 * shift is ~124 m on a consistent ~297° bearing (true WGS84 position is ~124 m
 * WNW of the OSGB36 coordinate).
 *
 * A common bug — and exactly what happened to the Sitefinder dataset — is to
 * convert National Grid eastings/northings to lat/lng off the Airy ellipsoid but
 * forget the OSGB36→WGS84 Helmert datum transformation. The result *looks* like
 * WGS84 (plausible degrees) but is shifted ~124 m, dropping riverside features
 * into the Thames. These functions apply the missing transformation.
 *
 * Accuracy: the 7-parameter Helmert transform is good to a few metres — ample
 * for placing features on the map. (Centimetre work would need OSTN15, which we
 * don't ship.)
 */

const DEG = Math.PI / 180;

// Airy 1830 (OSGB36) and GRS80/WGS84 ellipsoids.
const AIRY_A = 6377563.396;
const AIRY_B = 6356256.909;
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142;

// 7-parameter Helmert, OSGB36 → WGS84 (the negated OS "WGS84 → OSGB36" params).
// Translations in metres, rotations in arc-seconds, scale in ppm.
const HELMERT = {
  tx: 446.448,
  ty: -125.157,
  tz: 542.06,
  s: 20.4894e-6,
  rx: (0.1502 / 3600) * DEG,
  ry: (0.247 / 3600) * DEG,
  rz: (0.8421 / 3600) * DEG,
} as const;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Convert an OSGB36 geodetic latitude/longitude (degrees) to WGS84 (degrees).
 * Airy-ellipsoid geodetic → geocentric → Helmert → WGS84-ellipsoid geodetic.
 */
export function osgb36ToWgs84(latDeg: number, lngDeg: number, heightM = 0): LatLng {
  const lat = latDeg * DEG;
  const lng = lngDeg * DEG;

  // Geodetic (Airy) → geocentric cartesian.
  const e2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const nu = AIRY_A / Math.sqrt(1 - e2 * sinLat * sinLat);
  const x = (nu + heightM) * cosLat * Math.cos(lng);
  const y = (nu + heightM) * cosLat * Math.sin(lng);
  const z = ((1 - e2) * nu + heightM) * sinLat;

  // Helmert OSGB36 → WGS84.
  const { tx, ty, tz, s, rx, ry, rz } = HELMERT;
  const x2 = tx + (1 + s) * x - rz * y + ry * z;
  const y2 = ty + rz * x + (1 + s) * y - rx * z;
  const z2 = tz - ry * x + rx * y + (1 + s) * z;

  // Geocentric → geodetic (WGS84) by iteration.
  const e22 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - e22));
  for (let i = 0; i < 10; i++) {
    const sl = Math.sin(latW);
    const nu2 = WGS84_A / Math.sqrt(1 - e22 * sl * sl);
    latW = Math.atan2(z2 + e22 * nu2 * sl, p);
  }
  const lngW = Math.atan2(y2, x2);

  return { lat: latW / DEG, lng: lngW / DEG };
}

/**
 * Parse an OS National Grid reference (e.g. `TQ3225075840`) to easting/northing
 * metres (EPSG:27700). Returns null for malformed refs. Supports any even number
 * of digits (2–10) after the two-letter 100 km square.
 */
export function ngrToEastingNorthing(ngr: string): { easting: number; northing: number } | null {
  const s = ngr.replace(/\s+/g, '').toUpperCase();
  if (s.length < 4 || !/^[A-Z]{2}\d+$/.test(s)) return null;

  let l1 = s.charCodeAt(0) - 65;
  let l2 = s.charCodeAt(1) - 65;
  if (l1 > 7) l1 -= 1; // grid skips the letter 'I'
  if (l2 > 7) l2 -= 1;

  const e100 = (((l1 - 2) % 5) + 5) % 5 * 5 + (l2 % 5);
  const n100 = 19 - Math.floor(l1 / 5) * 5 - Math.floor(l2 / 5);

  const digits = s.slice(2);
  if (digits.length % 2 !== 0) return null;
  const half = digits.length / 2;
  const factor = 10 ** (5 - half);
  const easting = e100 * 100000 + parseInt(digits.slice(0, half), 10) * factor;
  const northing = n100 * 100000 + parseInt(digits.slice(half), 10) * factor;
  return { easting, northing };
}
