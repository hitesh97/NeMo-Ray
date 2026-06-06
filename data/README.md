# Data

Datasets for NeMo-Ray, organised by processing stage.

- **`retrieved/`** — raw data pulled from external sources, kept as fetched
  (lightly scoped/filtered only — no derivation).
- **`processed/`** — postprocessed / derived datasets produced by our pipeline.

## Contents

### `retrieved/`

- `SITEFINDER_London_EEproxy.csv` — Ofcom Sitefinder mobile-mast records scoped
  to Greater London, used as an EE network proxy. Columns: `Operator`, `Opref`,
  `Sitengr` (OS grid ref), `Antennaht`, `Transtype`, `Freqband`, `Powerdbw`,
  `Maxpwrdbw`, `Maxpwrdbm`, `Sitelat`, `Sitelng`.
- `police-counters.csv` — MOPAC London police-station closures (2017): station
  name, borough, `longitude`, `latitude`, and keep/cut status. ~137 rows.

## Coordinate reference systems (read before adding a layer)

"Decimal degrees" does **not** guarantee WGS84. Each dataset's CRS was verified,
and its correction lives in `nemoray/lib/geo/datasetCoordinates.ts` (loaders apply
it at parse time so the map only ever sees WGS84):

| Dataset | Stored CRS | Correction |
|---|---|---|
| Sitefinder masts | **OSGB36** geodetic (lat/lng match the inverse-TM of `Sitengr` to 0.0 m; ~124 m WNW of true WGS84) | `osgb36ToWgs84` datum shift |
| Police closures | **WGS84** (4 landmarks vs OpenStreetMap within ~16–25 m, scattered — no systematic offset) | identity |

**Adding a dataset (hospitals, fire, …):** spot-check 2–3 known buildings against
a WGS84 source (OSM/Google). ~20 m of random scatter ⇒ WGS84 (`identityLatLng`);
a consistent ~124 m WNW offset ⇒ OSGB36 (`osgb36ToWgs84`); raw eastings/northings
⇒ `ngrToEastingNorthing` then a grid→WGS84 step. Add the chosen corrector to
`datasetCoordinates.ts` with a one-line note on how you determined it.
