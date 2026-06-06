import { osgb36ToWgs84, ngrToEastingNorthing } from '../lib/geo/osgb';

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

describe('ngrToEastingNorthing', () => {
  test('parses a 10-figure London grid ref', () => {
    expect(ngrToEastingNorthing('TQ3225075840')).toEqual({ easting: 532250, northing: 175840 });
  });

  test('handles whitespace, lowercase, and coarser precision', () => {
    expect(ngrToEastingNorthing('tq 3225 7584')).toEqual({ easting: 532250, northing: 175840 });
    expect(ngrToEastingNorthing('TQ 32 75')).toEqual({ easting: 532000, northing: 175000 });
  });

  test('rejects malformed refs', () => {
    expect(ngrToEastingNorthing('')).toBeNull();
    expect(ngrToEastingNorthing('TQ123')).toBeNull(); // odd digit count
    expect(ngrToEastingNorthing('12345')).toBeNull();
  });
});

describe('osgb36ToWgs84', () => {
  test('shifts a known Sitefinder mast ~124 m WNW to its true WGS84 position', () => {
    // CSV (OSGB36) coords for TQ3225075840.
    const { lat, lng } = osgb36ToWgs84(51.46557, -0.095904);
    expect(lat).toBeCloseTo(51.46608, 4);
    expect(lng).toBeCloseTo(-0.09751, 4);

    const shift = haversineMeters(51.46557, -0.095904, lat, lng);
    expect(shift).toBeGreaterThan(118);
    expect(shift).toBeLessThan(130);
  });

  test('shift is consistently ~120–130 m across London', () => {
    for (const [la, lo] of [
      [51.52636, -0.35058],
      [51.50843, -0.5027],
      [51.52984, 0.15537],
    ] as const) {
      const w = osgb36ToWgs84(la, lo);
      const shift = haversineMeters(la, lo, w.lat, w.lng);
      expect(shift).toBeGreaterThan(118);
      expect(shift).toBeLessThan(130);
      // True position is north-west: latitude increases, longitude decreases.
      expect(w.lat).toBeGreaterThan(la);
      expect(w.lng).toBeLessThan(lo);
    }
  });
});
