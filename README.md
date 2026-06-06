# EE 4G Coverage & Resilience Digital Twin — Phase 1

Physically-based **radio propagation (ray tracing)** for the EE 4G network across
**Greater London**, with an interactive **3D view** built on deck.gl (animated trip-style ray
traces over extruded OSM buildings).

Phase 1 delivers:

1. A continuous **best-server signal-strength (RSS) coverage map** computed with
   [NVIDIA Sionna RT](https://github.com/NVlabs/sionna-rt) (GPU ray tracing) over real
   3D building geometry from OpenStreetMap.
2. Automatic detection of **low-coverage weak spots** (coverage holes).
3. A **CesiumJS** viewer that renders the **extruded OSM buildings** (untextured — the same
   meshes the ray tracer uses), drapes the coverage heatmap on the ground, and overlays EE
   masts, coverage holes, and **traced ray paths** — all individually toggleable.

## How it works

A single ray-tracing solve over all of London would be billions of grid cells and ~3M
building meshes at once — intractable. Instead the area is **tiled** (NVIDIA's
`sionna-large-radio-maps` pattern):

```
EE masts (Sitefinder CSV)  ─┐
                            ├─►  per 2 km tile:  OSM slice → Mitsuba scene → RadioMapSolver (GPU)
OSM 3D buildings (Geofabrik)┘                                                     │
                                                                                  ▼
                                            mosaic (max-combine, EPSG:27700) → coverage grid
                                                                                  │
                                       low-coverage hotspots + reproject to WGS84 │
                                                                                  ▼
                                          out/*.png + *.geojson  →  Cesium 3D viewer
```

- **Masts**: Orange + T-Mobile rows (together = EE) from `SITEFINDER_MAY_2012.csv`,
  filtered to Greater London, grouped into physical sites (`src/masts.py`).
- **Buildings**: extracted once from the Geofabrik Greater London `.osm.pbf` with PyOsmium,
  extruded to their OSM height, cached (`src/osm.py`, `src/scene_builder.py`).
- **Physics**: everything works in EPSG:27700 (British National Grid) so tiles align and the
  mosaic is seamless. Each tile is a Mitsuba scene with ITU radio materials; `RadioMapSolver`
  computes best-server RSS at 25 m resolution with reflections + diffraction (`src/rt.py`).
- **Coordinates**: reprojected to WGS84 only for the final web export (`src/export.py`).
- **3D view**: a self-contained **deck.gl** app (`viewer/`). Buildings (`out/buildings.geojson`)
  are extruded with a `GeoJsonLayer`; the ray traces (`out/paths.geojson`) animate as pulses with
  a `TripsLayer`, coloured by signal strength (orange = strong, blue = weak).

## Requirements

- NVIDIA GPU (developed on a **DGX Spark / GB10**, aarch64, CUDA 13). CPU fallback works via
  Dr.Jit's LLVM backend but is far slower.
- Python 3.12.

```bash
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The first run downloads the Greater London OSM extract (~120 MB) if it is not already in
`data/`:

```bash
curl -L -o data/greater-london-latest.osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf
```

## Running the pipeline

```bash
source .venv/bin/activate

# Fast smoke test — one 2 km tile over central London (~6 s):
python -m src.pipeline --subset central

# Richer demo — 3x3 tiles around the centre (~30 s):
python -m src.pipeline --subset central3x3

# Other named subsets:
python -m src.pipeline --subset city_canary   # 8 km square: City of London + Canary Wharf
python -m src.pipeline --subset canarywharf
python -m src.pipeline --subset battersea

# Full Greater London (batch; resumable, per-tile cached):
python -m src.pipeline --resume
python -m src.pipeline --resume --limit 50   # cap tiles for a partial run
```

Useful flags: `--cell-size <m>`, `--max-depth <n>`, `--resume`, `--limit <n>`.
Outputs land in `out/`: `coverage.png`, `coverage_bounds.json`, `buildings.geojson`,
`masts.geojson`, `hotspots.geojson`, `paths.geojson`, `summary.json`.

## Viewing in 3D

The viewer is a **deck.gl** app styled after deck.gl's [`trips`](https://github.com/visgl/deck.gl/tree/9.3-release/examples/website/trips)
example — fully local, no map service or API key. The ray traces animate as flowing pulses
(deck.gl `TripsLayer`) over extruded OSM buildings (`GeoJsonLayer`), under the trips theme's
lighting. Serve it with the small built-in server (which also exposes the `POST /api/optimize`
endpoint behind the **Optimise** button):

```bash
# Serve from the project root so /out and /viewer resolve:
python -m src.serve
# then open:  http://localhost:8000/viewer/
```

Signal strength is shown **directly in the traces** — orange = strong, blue = weak (a
pseudo-RSS from path length + bounce count), so there's no separate coverage heatmap. Toggle
layers from the dashboard: **OSM buildings**, **EE masts**, **coverage holes**, **ray traces**,
and **proposed masts (cuOpt)**. The dashboard also shows the network KPIs, the cuOpt
before/after optimisation result, and GPU/latency telemetry.

> Rendering *all* rays is heavy: a `central3x3` run produces ~230k polylines (~60 MB
> `paths.geojson`). It loads fine on a GPU but takes a few seconds and a fair bit of memory.
> The ring density per mast (and thus the ray count) is set in `src/rt.py` (`ring`), and a
> hard ceiling is `radio.ray_total_cap` in `config.yaml`.

### GPU & latency telemetry

The pipeline samples GPU utilisation and this process's GPU memory while the heavy Sionna RT
computation runs (via `nvidia-smi`; on the unified-memory GB10, per-process GPU memory is the
meaningful "VRAM" figure). It also records per-tile solve latency and ray throughput. These
land in `out/summary.json` under `performance` and are shown in the viewer's **GPU & latency**
panel — e.g. peak/mean GPU util, peak GPU memory, mean/max coverage-solve latency per tile,
ray-trace throughput, and end-to-end wall time.

## Phase 2 — cuOpt mast-placement optimisation

Given the coverage holes found by the RT pass, **NVIDIA cuOpt** decides where to add new
masts to fix them with the **fewest masts**. It is framed as a maximal-coverage / set-cover
MILP and solved on NVIDIA's **hosted cuOpt service** (no local install):

```
minimise   Σ y_j                              (y_j = build a new mast at candidate site j)
s.t.       Σ_{j covers hole i} y_j ≥ 1   ∀ i  (every coverage hole served by ≥1 new mast)
           y_j ∈ {0,1}
```

Demand points are the low-coverage hotspot centroids; candidate sites are a grid over the
weak areas; a candidate "covers" a hole within `cuopt.coverage_radius_m`. Run it after the
pipeline (it reads `out/hotspots.geojson`):

```bash
python -m src.optimize
```

It POSTs the MILP to `https://optimize.api.nvidia.com/v1/nvidia/cuopt` with the `nvapi-` key
in `config.yaml` and writes `out/new_masts.geojson` + `out/optimization.json`. `src/cuopt.py`
is the thin hosted-API client; `src/optimize.py` builds the MILP. cuOpt also ships an aarch64
`cuopt-cu12` wheel if you prefer to run it locally on the GPU.

The coverage model is **physically faithful**: a candidate covers a weak spot only if it is
within a short multipath range, or within a longer range with **clear line-of-sight** (no
building footprint between them). Demand is restricted to **outdoor** holes — a low-coverage
cell whose centroid is inside a building footprint is a radio-map artifact, not a real gap.

### Verification — recompute the rays and prove it

`src/verify.py` then **proves** the placement with ray tracing rather than trusting the proxy:

```bash
python -m src.verify        # (the Optimise button runs optimise + verify together)
```

It reconstructs the simulated tiles, re-runs Sionna RT **only for the tiles a new mast
affects** (with the proposed masts added as transmitters), re-mosaics + re-exports the
coverage and hotspots, recomputes the rays for those tiles (the new masts' rays →
`out/new_rays.geojson`), and checks every former outdoor hole is now served. Result on the
**City of London + Canary Wharf** square (`--subset city_canary`): **49 new masts → 100% of
the 53 outdoor holes verified served by RT** (`out/verification.json`). This physics-in-the-loop
step is exactly what caught the naive distance proxy over-promising (it had only ~33% real
coverage); the fix was a line-of-sight-aware coverage model + a tight `near_radius`. The viewer's **Optimise** button runs
the whole optimise→re-simulate→verify loop and updates the coverage, holes, gold masts, their
rays, and an **RT verification** panel live.

## Scaling to all of Greater London

`python -m src.pipeline --resume` runs the whole **721-tile** Greater London grid (~9 min on
the GB10, resumable). The coverage science scales cleanly; two things to know:

- **Viewer artifacts don't scale to the whole city.** Full GL exports ~1.1M buildings
  (`buildings.geojson`) and ~500k rays (`paths.geojson`) — too heavy for a browser. For a
  GL-wide view, toggle **OSM buildings** and **Ray paths** off and keep the coverage heatmap +
  masts + hotspots; use a `--subset` for the immersive 3D buildings/rays.
- **Optimisation is a regional tool.** GL has tens of thousands of holes. `src/optimize.py`
  uses a compact dominating-set MILP (candidates = hole locations, sparse KD-tree coverage) and
  is capped by `cuopt.max_holes` (largest gaps first) so the hosted solver stays happy. RT
  verification is capped by `cuopt.max_verify_tiles`. For a fast, fully-verified demo, run the
  pipeline + Optimise button on a **subset** (e.g. `central3x3`); on a GL-wide run the optimiser
  still works on the worst holes, but RT-verifying masts scattered across all London is a batch
  operation, not a click.

## Configuration

All knobs live in `config.yaml`: bounding box, operators, carrier frequency (1800 MHz),
tile/cell sizes, ray depth, building-height defaults, the low-coverage threshold
(−110 dBm), named subsets, and the focus tile used for ray-path visualisation.

## Layout

```
config.yaml            pipeline configuration
requirements.txt
src/
  config.py            config loader
  geo.py               WGS84 <-> BNG transforms, tile grid
  masts.py             EE site loader from Sitefinder
  osm.py               OSM building extraction + cache
  scene_builder.py     OSM slice -> Mitsuba/Sionna scene
  rt.py                RadioMapSolver (coverage) + ray-path tracer (all masts)
  mosaic.py            tile stitching + hotspot polygonisation
  gpu.py               GPU utilisation / memory telemetry sampler
  export.py            coverage PNG + buildings/masts/hotspots/paths GeoJSON
  pipeline.py          orchestration + CLI + performance capture
viewer/                CesiumJS app (index.html, app.js, config.js)
data/                  OSM pbf, building cache, per-tile scene + result cache
out/                   web artifacts
```

## Notes & limitations (Phase 1)

- Sitefinder is a 2012 snapshot; sites are treated as EE 4G transmitters at 1800 MHz.
- Buildings use a flat ground plane and ITU concrete material; terrain relief and detailed
  per-surface materials are out of scope for Phase 1.
- "Best-server RSS" = strongest received power across all masts illuminating each cell.
- Phases 2–4 (cuOpt mast/power optimisation, Nemotron agent, Starlink failover) build on
  these coverage artifacts.
