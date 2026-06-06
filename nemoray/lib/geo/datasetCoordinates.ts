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
 *   0.0 m, ~124 m WNW of true WGS84). ⇒ apply the OSGB36→WGS84 datum shift.
 *   The ray-tracing pipeline (`src/masts.py`) now applies the same shift, so the
 *   exported rays/masts and this layer share the corrected WGS84 frame.
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
import { osgb36ToWgs84, osNationalGridToWgs84, type LatLng } from './osgb';

export type LatLngCorrector = (lat: number, lng: number) => LatLng;

/** Coordinates are already WGS84 — pass through unchanged. */
export const identityLatLng: LatLngCorrector = (lat, lng) => ({ lat, lng });

/**
 * Sitefinder masts: stored coordinates ARE OSGB36 geodetic (~124 m WNW of true
 * WGS84) → apply the OSGB36→WGS84 datum shift so the served masts are true WGS84.
 *
 * The Sionna ray-tracing pipeline (`src/masts.py`) now applies the matching shift
 * in `load_sites` (via `geo.osgb36_to_wgs84`), so every traced ray in
 * `paths.geojson` and the exported `masts.geojson` already originate from the
 * corrected WGS84 position. This corrector keeps the CSV-served masts in that same
 * frame, so the Network panel (`/api/sitefinder`) and the deck.gl surface agree.
 * (Previously this was identity, to match the then-uncorrected pipeline; that
 * workaround is obsolete now the pipeline applies the shift at the source.)
 */
export const correctSitefinderLatLng: LatLngCorrector = (lat, lng) => osgb36ToWgs84(lat, lng);

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
