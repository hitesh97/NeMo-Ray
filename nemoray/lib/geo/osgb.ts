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
 * Convert OS National Grid eastings/northings (EPSG:27700, metres) to WGS84
 * lat/lng (degrees). Inverse Transverse Mercator on the Airy 1830 ellipsoid
 * gives OSGB36 geodetic coordinates, which then go through the Helmert datum
 * shift (`osgb36ToWgs84`) — skip that second step and features land ~124 m off,
 * the classic National-Grid bug. Algorithm: OS "A Guide to Coordinate Systems in
 * Great Britain", section C.2.
 */
export function osNationalGridToWgs84(easting: number, northing: number): LatLng {
  const F0 = 0.9996012717; // central-meridian scale factor
  const lat0 = 49 * DEG; // true origin latitude
  const lng0 = -2 * DEG; // true origin longitude
  const N0 = -100000; // northing of true origin
  const E0 = 400000; // easting of true origin
  const e2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const n = (AIRY_A - AIRY_B) / (AIRY_A + AIRY_B);
  const n2 = n * n;
  const n3 = n * n * n;

  // Iterate latitude until the meridional arc M matches (northing - N0).
  let lat = lat0;
  let M = 0;
  do {
    lat = (northing - N0 - M) / (AIRY_A * F0) + lat;
    const dLat = lat - lat0;
    const sLat = lat + lat0;
    M =
      AIRY_B *
      F0 *
      ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * dLat -
        (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dLat) * Math.cos(sLat) +
        ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat) -
        (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat));
  } while (Math.abs(northing - N0 - M) >= 0.00001);

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const tan2 = tanLat * tanLat;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;
  const secLat = 1 / cosLat;

  const nu = (AIRY_A * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (AIRY_A * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const dE = easting - E0;
  const dE2 = dE * dE;
  const dE3 = dE2 * dE;
  const dE4 = dE2 * dE2;
  const dE5 = dE4 * dE;
  const dE6 = dE4 * dE2;
  const dE7 = dE6 * dE;

  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu;
  const XI = (secLat / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const XII = (secLat / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = (secLat / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const latOsgb = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  const lngOsgb = lng0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  // The above is OSGB36 geodetic (Airy) — apply the datum shift to WGS84.
  return osgb36ToWgs84(latOsgb / DEG, lngOsgb / DEG);
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
