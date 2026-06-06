/**
 * Per-dataset coordinate correctors → WGS84.
 *
 * Each external dataset is published in some coordinate reference system, and
 * "decimal degrees" does NOT guarantee WGS84 (the Sitefinder file is degrees but
 * in the OSGB36 datum). Every dataset gets one corrector here, chosen from a
 * *verified* analysis of its coordinates — never assumed. The map only ever
 * consumes WGS84, so loaders run their dataset's corrector at parse time.
 *
 * How each was determined (see also `data/README.md`):
 *
 * - **Sitefinder masts** — the CSV lat/lng are OSGB36 (they match the
 *   inverse-Transverse-Mercator OSGB36 lat/lng of their National Grid refs to
 *   0.0 m, ~124 m WNW of true WGS84). NB despite that, this layer uses identity,
 *   NOT the datum shift — the ray-tracing pipeline consumes the same raw coords
 *   uncorrected, so the antennas must stay in the rays' frame to align with them.
 *   See `correctSitefinderLatLng` below.
 * - **MOPAC police-station closures** — four landmark stations checked against
 *   OpenStreetMap (WGS84) sit within ~16–25 m in scattered directions (no
 *   systematic ~124 m WNW signature). ⇒ already WGS84; identity.
 *
 * To add a new layer (hospitals, fire stations, …): spot-check 2–3 known
 * buildings against a WGS84 source first. ~20 m of random scatter ⇒ WGS84, use
 * `identityLatLng`. A consistent ~124 m WNW offset ⇒ OSGB36, use `osgb36ToWgs84`.
 * Raw eastings/northings ⇒ `ngrToEastingNorthing` then a grid→WGS84 conversion.
 */
import { osNationalGridToWgs84, type LatLng } from './osgb';

export type LatLngCorrector = (lat: number, lng: number) => LatLng;

/** Coordinates are already WGS84 — pass through unchanged. */
export const identityLatLng: LatLngCorrector = (lat, lng) => ({ lat, lng });

/**
 * Sitefinder masts: stored coordinates ARE OSGB36 geodetic (~124 m WNW of true
 * WGS84) — but we deliberately pass them through unchanged.
 *
 * The Sionna ray-tracing pipeline (`src/masts.py`) feeds these same raw CSV
 * lat/lng straight into the physics without the datum shift, so every traced ray
 * in `paths.geojson` originates from the uncorrected position. Applying the
 * OSGB36→WGS84 correction here moved the antennas to true WGS84 and left them
 * ~125 m off the rays they belong to. Until the pipeline applies the matching
 * shift, the antenna layer must live in the same (uncorrected) frame as the rays
 * so masts and ray tracing line up. Swap back to `osgb36ToWgs84` once the
 * pipeline is corrected too — see this repo's `src/masts.py`.
 */
export const correctSitefinderLatLng: LatLngCorrector = identityLatLng;

/** MOPAC police-station closures: verified WGS84 → no correction. */
export const correctPoliceLatLng: LatLngCorrector = identityLatLng;

/**
 * NHS hospital locations: published as plain WGS84 decimal degrees (OSM-derived),
 * no systematic ~124 m offset → identity.
 */
export const correctHospitalLatLng: LatLngCorrector = identityLatLng;

/**
 * London Fire Brigade assets: published as OS National Grid eastings/northings
 * (EPSG:27700), not lat/lng. The loader converts the grid metres straight to
 * WGS84 with this helper rather than going through a `LatLngCorrector`.
 */
export const correctFireEastingNorthing = (easting: number, northing: number): LatLng =>
  osNationalGridToWgs84(easting, northing);
