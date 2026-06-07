# NeMo-Ray — EE 4G Coverage & Resilience Digital Twin

![NeMo-Ray overview](media/overview.gif)

GPU-accelerated **radio propagation digital twin** of the UK Emergency Services Network (ESN)
4G/LTE coverage across Greater London. Physically-based ray tracing models real building
geometry; an agentic optimise-and-resilience layer powered by Nemotron LLM reasons over outages,
proposes new masts, and deploys Cell-on-Wheels with Starlink backhaul — all running locally on a
DGX Spark GB10.

---

## NVIDIA Technologies

| Technology | Role |
| --- | --- |
| **[NVIDIA Sionna RT](https://github.com/NVlabs/sionna-rt)** v2.0.1 | GPU ray-tracing radio propagation — computes best-server RSS coverage at 25 m resolution over 3D OSM building geometry tiled across Greater London |
| **[NVIDIA cuOpt](https://developer.nvidia.com/cuopt-logistics-optimization)** | Hosted MILP service (`optimize.api.nvidia.com`) — frames coverage-hole repair as a minimum set-cover problem and solves it; also deployable locally as `cuopt-server-cu13` on-GPU |
| **[NVIDIA Nemotron-3](https://www.nvidia.com/en-us/ai-data-science/products/nemotron/)** | LLM backbone (NVFP4 quantised, served via vLLM on the DGX Spark) for the agentic ReAct loop that drives outage simulation, mast relocation, COW dispatch, and resilience planning |
| **[NVIDIA DGX Spark / GB10](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)** | Primary compute target — ~121 GB unified memory, aarch64, CUDA 13; the Sionna RT tiling pattern is tuned for the GB10 memory envelope |
| **[Mitsuba 3](https://mitsuba-renderer.org/)** v3.8.0 | Physically-based scene representation — each 2 km tile is a Mitsuba scene with ITU radio materials before the Sionna `RadioMapSolver` runs |
| **[Dr.Jit](https://github.com/mitsuba-renderer/drjit)** v1.3.1 | Differentiable JIT compiler underlying Sionna RT; LLVM backend provides CPU fallback when no GPU is present |
| **NVIDIA cuOpt API** | REST endpoint (`https://optimize.api.nvidia.com/v1/nvidia/cuopt`) accepting a MILP in JSON; `nvapi-` key from [build.nvidia.com](https://build.nvidia.com) |
| **Nemotron NIM** | OpenAI-compatible `/v1/chat/completions` endpoint served by `scripts/serve_nemotron.sh` (vLLM, NVFP4); `nano` 30B fits alongside the twin; `super` 120B uses most of the box |
| **`nvidia-smi`** | GPU utilisation + per-process memory telemetry sampled during the Sionna RT solve; published in `summary.json` and shown in the HUD KPI panel |

---

## Full Technology Stack

### Python pipeline (`src/`, `agent/`, `modellingsim/`)

| Package | Version | Purpose |
| --- | --- | --- |
| `sionna-rt` | 2.0.1 | GPU ray-tracing radio-map solver |
| `mitsuba` | 3.8.0 | 3D scene representation + ITU material library |
| `drjit` | 1.3.1 | JIT differentiable backend for Sionna/Mitsuba |
| `cuopt-server-cu13` | 26.4.0 | Local cuOpt MILP solver (on-GPU fallback) |
| `cuopt-sh-client` | 26.4.0 | Client library for the hosted / local cuOpt service |
| `fastapi` | ≥0.115 | Agent SSE bridge server (`agent/server.py`) + twin API (`src/serve.py`) |
| `uvicorn` | ≥0.30 | ASGI server for the agent bridge |
| `geopandas` | 1.1.3 | Geospatial data frames (hotspot detection, export) |
| `shapely` | 2.1.2 | Geometry operations (LOS, coverage polygons) |
| `pyproj` | 3.7.2 | CRS transformations — EPSG:27700 (BNG) ↔ WGS84 |
| `rasterio` | 1.5.0 | EA LiDAR raster reads for line-of-sight checks |
| `osmium` | 4.3.1 | High-performance OSM PBF parsing (building footprints) |
| `trimesh` | 4.12.2 | 3D mesh loading + extrusion |
| `manifold3d` | 3.5.1 | 3D mesh boolean + CSG operations |
| `mapbox_earcut` | 2.0.0 | Polygon triangulation (building mesh export) |
| `numpy` | 2.4.6 | Numerical arrays |
| `matplotlib` | 3.10.9 | Coverage raster PNG export |
| `pillow` | 10.2.0 | Image I/O |
| `requests` / `httpx` | 2.31.0 / ≥0.27 | HTTP clients (cuOpt API, twin calls) |
| `PyYAML` | 6.0.1 | `config.yaml` parsing |
| vLLM | (system) | Serves the Nemotron NIM endpoint on DGX Spark |
| Skyfield | (agent) | Starlink TLE orbital propagation + pass visibility |
| uv | ≥0.6 | Python workspace package manager |

### Next.js HUD (`nemoray/`)

| Package | Version | Purpose |
| --- | --- | --- |
| **Next.js** | 16.2.7 | App Router, SSR, API route handlers |
| **React** | 19.2.4 | UI framework |
| **TypeScript** | ^5 | Strict typing across the whole HUD |
| **Tailwind CSS** | v4 | Utility-first CSS with `@theme` design tokens |
| **deck.gl** | 9.3.3 | GPU-accelerated data-vis layers (`TripsLayer`, `GeoJsonLayer`, `ScatterplotLayer`, `PathLayer`) |
| **MapLibre GL** | 5.24.0 | WebGL base map (streets, terrain) |
| `@deck.gl/mapbox` | 9.3.3 | `MapboxOverlay` — mounts deck layers over MapLibre |
| **Zustand** | 5.0.14 | Global state store (scenario, network, layers, agent, timeline, camera) |
| **Radix UI** | ^1 | Accessible dialog, slider, switch, tooltip primitives |
| **Motion** (Framer) | 12.40.0 | Animation (panel transitions, streaming tokens) |
| `satellite.js` | 7.0.1 | Client-side Starlink TLE propagation (orbit arc overlay) |
| `lucide-react` | 1.17.0 | Icon set |
| `clsx` / `tailwind-merge` | — | Class-name utilities |
| pnpm | ≥10 | Package manager (workspace + lockfile local to `nemoray/`) |

### External APIs

| API | Provider | Usage |
| --- | --- | --- |
| cuOpt MILP endpoint | NVIDIA (`optimize.api.nvidia.com`) | Set-cover mast-placement solve (Phase 2) |
| Nemotron NIM | NVIDIA (local vLLM) | LLM chat completions for the agent ReAct loop |
| ElevenLabs Scribe (STT) | ElevenLabs | Voice-to-text in the HUD agent composer |
| ElevenLabs TTS turbo | ElevenLabs | Text-to-speech for agent responses |
| OpenCellID | Community | Live EE tower locations (MNC 20/30) via `/api/sitefinder` |
| MapTiler | MapTiler | Raster/vector base map tiles (`NEXT_PUBLIC_MAPTILER_KEY`) |

---

## Datasets

| Dataset | Source | Contents | CRS |
| --- | --- | --- | --- |
| **Ofcom Sitefinder (May 2012)** | Ofcom | UK mobile-mast registry; Orange + T-Mobile rows (together = EE) scoped to Greater London — operator, grid ref, antenna height, frequency, power | OSGB36 geodetic (datum-shifted on load) |
| **Greater London OSM extract** | [Geofabrik](https://download.geofabrik.de/europe/united-kingdom/england/greater-london.html) | OpenStreetMap building footprints + heights (`greater-london-latest.osm.pbf`, ~120 MB) — the same meshes Sionna RT uses for propagation | WGS84 |
| **OpenCellID towers** | Community / OpenCellID | Live EE cell tower positions, filtered by MNC 20 and 30 | WGS84 |
| **EA LiDAR DSM/DTM** | Environment Agency | Digital Surface Model + Digital Terrain Model rasters; used by `lidar.py` for physics-accurate line-of-sight validation in `validate_site` | OSGB36 BNG (EPSG:27700) |
| **Starlink TLE set** | Space-Track / public | Two-Line Element orbital elements for the Starlink constellation (`data/starlink_tle.txt`); propagated by Skyfield for satellite pass windows | N/A |
| **London Fire Brigade stations** | LFB open data | Station name, location, and borough (`fire-stations-london.csv`) — used for COW dispatch ETA modelling | WGS84 |
| **London police stations** | MOPAC | Station name, borough, keep/cut status, coordinates (`police-stations-london.csv`, ~137 rows) | WGS84 |
| **NHS hospitals (England)** | NHS Digital | Hospital name and location (`hospitals-england.csv`) | WGS84 |
| **Pipeline-generated artifacts** | `src/pipeline.py` | Coverage raster, building mesh, mast + hotspot + ray-path GeoJSON, optimisation + verification results — written to `nemoray/public/raytracing/` | WGS84 |

---

## Repository Layout

```
NeMo-Ray/
├── src/                        # Python pipeline (Sionna RT, cuOpt, verification)
│   ├── pipeline.py             # Top-level orchestrator — tile, solve, mosaic, export
│   ├── rt.py                   # Sionna RT radio-map solve + ray-path export
│   ├── scene_builder.py        # OSM → Mitsuba scene (buildings, ground, transmitters)
│   ├── osm.py                  # PyOsmium: parse PBF, cache building footprints
│   ├── masts.py                # Sitefinder CSV → EE mast objects (OSGB36 → WGS84)
│   ├── mosaic.py               # Max-combine per-tile coverage grids
│   ├── export.py               # Coverage PNG + GeoJSON artifacts → out_dir
│   ├── optimize.py             # cuOpt MILP: set-cover mast placement
│   ├── cuopt.py                # Thin hosted-API client for NVIDIA cuOpt
│   ├── verify.py               # Physics-in-the-loop RT verification of cuOpt plan
│   ├── resimulate.py           # Re-sim affected tiles after outage / new mast
│   ├── serve.py                # FastAPI twin server (coverage / optimize / rays APIs)
│   ├── emergency.py            # Emergency-service data routes
│   ├── history.py              # Run-history management
│   ├── gpu.py                  # nvidia-smi telemetry sampler
│   ├── geo.py                  # Coordinate utilities (OSGB36 ↔ WGS84, BNG)
│   └── config.py               # config.yaml loader
│
├── agent/                      # Nemotron resilience agent (FastAPI/SSE)
│   └── nemoray_modelling/
│       ├── agent.py            # ReAct loop (LlamaCppPlanner + StubPlanner)
│       ├── tools.py            # 12 tools: outage, COW, cuOpt, Sionna, Starlink, …
│       ├── server.py           # FastAPI SSE bridge (POST /agent, GET /health)
│       ├── events.py           # AgentStreamEvent frame builders (wire protocol)
│       ├── emergency.py        # COW dispatch, restoration ETA, emergency-service data
│       ├── places.py           # Spatial knowledge graph (gazetteer, masts, holes)
│       ├── starlink.py         # Skyfield satellite-pass visibility
│       ├── tle.py              # TLE set loader
│       └── lidar.py            # EA LiDAR line-of-sight check
│
├── nemoray/                    # Next.js 16 HUD (primary front-end)
│   ├── app/                    # App Router (layout, workspaces, API routes)
│   │   ├── (workspaces)/       # mission · coverage · optimiser · agent · scenarios
│   │   └── api/                # agent (SSE), sitefinder, emergency-services, voice
│   ├── components/
│   │   ├── map/                # DeckScene (deck.gl / MapLibre), MapMount
│   │   ├── agent/              # AgentRunner, AgentConsole, ToolPipeline, ToolCard
│   │   ├── panels/             # LeftRail, RightRail (cuOpt / Stats), BottomBar
│   │   ├── kpi/                # NetworkStatusPanel, RenderTelemetryPanel
│   │   ├── scenario/           # ScenarioTabs, EventTimeline, TimelineMarker
│   │   ├── optimiser/          # ProposalList, ProposalCard, ValidationVerdict
│   │   ├── layers/             # LayerToggle, MapLayersPanel
│   │   └── primitives/         # Panel, Button, Badge, Readout, StatusDot, …
│   ├── hooks/                  # useStreamingAgent, useVoice, useScenarioTimeline, …
│   ├── lib/                    # types, config, layers, scenarios, geo/, api/, data/
│   ├── store/                  # Zustand store (index.ts) + selector hooks
│   ├── data/                   # London CSVs: sitefinder-proxy, fire/police/hospitals
│   ├── public/
│   │   ├── raytracing/         # Pipeline artifacts (gitignored; regenerate via pipeline)
│   │   ├── geo/                # landmarks.json (gazetteer for map labels + agent KG)
│   │   └── icons/              # Emergency-service map-pin SVGs
│   └── docs/                   # INVARIANTS.md, DESIGN-SYSTEM.md
│
├── viewer/                     # Standalone deck.gl viewer (CDN; no build step)
│   ├── index.html              # Entry point
│   ├── app.js                  # TripsLayer rays + GeoJsonLayer buildings + controls
│   └── config.js               # Viewer constants (colours, animation, endpoints)
│
├── modellingsim/               # cuOpt + Nemotron smoke tests
│   └── src/nemoray_modelling/  # agent, nemotron, cuOpt, emergency, lidar clients
│
├── data/                       # Input datasets
│   ├── greater-london-latest.osm.pbf   # Geofabrik OSM extract (~120 MB)
│   ├── buildings.pkl           # Cached building footprints (PyOsmium output)
│   ├── tiles/                  # Per-tile Sionna scene + result cache
│   ├── emergency/              # Fire / police / hospital CSVs
│   └── starlink_tle.txt        # Starlink Two-Line Elements
│
├── datasets/                   # Retrieved + processed datasets with provenance notes
│   ├── retrieved/              # SITEFINDER_London_EEproxy.csv, police-counters.csv
│   └── processed/              # Derived pipeline outputs
│
├── scripts/
│   └── serve_nemotron.sh       # Launch Nemotron NIM (vLLM NVFP4) on DGX Spark
│
├── spark/                      # DGX Spark (GB10) deployment scripts + CLAUDE.md
├── brev/                       # Brev H200 cloud mirror
├── out/                        # Legacy pipeline output dir
├── SITEFINDER_MAY_2012.csv     # Ofcom Sitefinder base dataset (full UK)
├── config.yaml                 # Pipeline configuration (bbox, radio, tiling, cuOpt)
├── requirements.txt            # Python deps for src/ (pip/venv path)
├── pyproject.toml              # uv workspace config (root + modellingsim member)
└── uv.lock                     # Locked dependency graph
```

---

## Architecture Overview

```
SITEFINDER_MAY_2012.csv ─┐
data/greater-london.osm.pbf ─┴──► src/ (Python pipeline, GPU)
                                   │  Sionna RT tiled coverage solve
                                   │  cuOpt MILP mast placement
                                   │  RT verification (physics-in-the-loop)
                                   │  writes artifacts to ──────────────────────────┐
                                                                                    ▼
                                                          nemoray/public/raytracing/
                                                          coverage.png + bounds.json
                                                          buildings / masts / hotspots
                                                          paths / new_masts / new_rays
                                                          optimization + verification JSON
                                                                     │           │
                                   ┌───────────────────────────────────┘           │
                                   ▼                                               ▼
              viewer/ (standalone deck.gl, CDN)            nemoray/ (Next.js 16 HUD — primary)
                                                               deck.gl map, Nemotron agent chat,
                                                               cuOpt proposals, scenario timeline

nemoray HUD ──POST /agent (SSE)──► agent/server.py (:8001)
                                    │  Nemotron ReAct loop
                                    ├──/v1/chat/completions──► Nemotron NIM (:8080)
                                    │                          (vLLM NVFP4 on DGX Spark)
                                    └──/api/coverage|optimize|rays──► src/serve.py (:8000)
                                                                        (re-sim affected tiles)
```

---

## Getting Started

### Prerequisites

- NVIDIA GPU (developed on **DGX Spark GB10**, aarch64, CUDA 13; CPU fallback via Dr.Jit LLVM works but is far slower)
- Python 3.12
- Node.js ≥ 20
- [pnpm](https://pnpm.io/) ≥ 10 (`corepack enable`)
- [uv](https://docs.astral.sh/uv/) (Python workspace manager)

### Next.js HUD

```bash
git clone https://github.com/Harrishayy/NeMo-Ray.git
cd NeMo-Ray/nemoray
pnpm install
pnpm dev         # http://localhost:3000
```

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the dev server (Turbopack) |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm lint` | ESLint |
| `pnpm test` | Jest unit tests |

### Python pipeline

```bash
# From the repo root
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements.txt

# Download the OSM extract (~120 MB) if not present
curl -L -o data/greater-london-latest.osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf

# Fast smoke test — one 2 km tile over central London (~6 s on GB10)
python -m src.pipeline --subset central

# 3×3 tile demo (~30 s)
python -m src.pipeline --subset central3x3

# Full Greater London (721 tiles, ~9 min on GB10; resumable)
python -m src.pipeline --resume
```

Output artifacts land in `nemoray/public/raytracing/` and are served live by the HUD.

### Phase 2 — cuOpt mast optimisation

```bash
# Requires CUOPT_API_KEY from https://build.nvidia.com
export CUOPT_API_KEY="nvapi-..."
python -m src.optimize      # writes new_masts.geojson + optimization.json
python -m src.verify        # RT-verifies every proposed mast
```

### Nemotron agent

```bash
# 1) Start the coverage twin
python -m src.serve                    # :8000

# 2) Serve Nemotron NIM (DGX Spark; vLLM NVFP4)
./scripts/serve_nemotron.sh            # :8080

# 3) Start the agent SSE bridge
cd agent && pip install -e .
TWIN_URL=http://localhost:8000 \
NEMOTRON_BASE_URL=http://localhost:8080 \
  uvicorn nemoray_modelling.server:app --port 8001
```

The `StubPlanner` provides deterministic offline behaviour when no NIM is running.

---

## Pipeline Deep-Dive

### Ray-tracing tiled coverage solve

A single solve over all of London would be billions of grid cells — intractable. Instead the
area is tiled (NVIDIA's `sionna-large-radio-maps` pattern):

```
EE masts (Sitefinder CSV)   ─┐
                              ├─► per 2 km tile: OSM slice → Mitsuba scene → RadioMapSolver (GPU)
OSM 3D buildings (Geofabrik) ─┘                                                    │
                                                                                   ▼
                                         mosaic (max-combine, EPSG:27700) → coverage grid
                                                                                   │
                                    low-coverage hotspots + reproject to WGS84    │
                                                                                   ▼
                                      out/*.png + *.geojson  →  deck.gl 3D viewer
```

- **Physics**: EPSG:27700 (British National Grid) so tiles align seamlessly. Each tile is a
  Mitsuba scene with ITU radio materials; `RadioMapSolver` computes best-server RSS at 25 m
  resolution with reflections + diffraction.
- **Frequency**: 1800 MHz (EE's primary 4G band, matching the Sitefinder `Freqband=1800` column).
- **Coverage threshold**: −110 dBm (below = no usable service).

### cuOpt mast-placement (Phase 2)

Frames hole-repair as a minimum set-cover MILP:

```
minimise   Σ y_j                              (y_j = build a new mast at candidate site j)
s.t.       Σ_{j covers hole i} y_j ≥ 1   ∀ i  (every outdoor hole served by ≥1 new mast)
           y_j ∈ {0,1}
```

A candidate covers a hole within `near_radius_m` (multipath range) or `coverage_radius_m`
with clear line-of-sight. Demand is restricted to outdoor holes — indoor radio-map artefacts
are excluded. Result on the City of London + Canary Wharf square: **49 new masts → 100% of 53
outdoor holes RT-verified as served**.

### Nemotron resilience agent

A tool-calling **ReAct agent** (`agent/agent.py`) that drives the twin over HTTP. Tools:

| Tool | Backend |
| --- | --- |
| `simulate_outage` | Marks masts offline; redraws dead-zone polygons on the HUD map |
| `run_sionna_coverage` | Re-sims affected tiles with the twin (`src/resimulate.py`) |
| `run_cuopt` | Posts a fresh MILP to the cuOpt service |
| `validate_site` | LiDAR-based line-of-sight check for a proposed mast |
| `deploy_cow` | Computes COW dispatch ETA from nearest LFB depot; draws tow route on map |
| `check_starlink` | Skyfield pass window for Starlink backhaul availability |
| `find_nearest` | Nearest emergency-service building in / near a dead zone |
| `locate_place` / `nearby_places` / `describe_network` / `find_masts` | Spatial knowledge-graph queries |

Every tool returns `ui_actions` (WGS84 geometry) which stream as `map_action` frames to the
HUD, painting dead zones, COW routes, and camera fly-tos in real time.

---

## Configuration

All pipeline knobs live in `config.yaml`: bounding box, operators, carrier frequency (1800 MHz),
tile/cell sizes, ray depth, building-height defaults, the coverage threshold (−110 dBm), named
subsets (`central`, `central3x3`, `city_canary`, `westminster_canary`, …), and cuOpt solver
parameters.

Environment variables (`.env.example`):

| Variable | Purpose |
| --- | --- |
| `CUOPT_API_KEY` | NVIDIA cuOpt hosted-API key (`nvapi-…`) |
| `TWIN_URL` | Coverage-twin base URL (default `http://localhost:8000`) |
| `NEMOTRON_BASE_URL` | Nemotron NIM base URL (default `http://localhost:8080`) |
| `NEMOTRON_MODEL` | Model ID passed to the NIM |
| `AGENT_LLM` | `auto` \| `nim` \| `stub` |
| `LIDAR_DSM` / `LIDAR_DTM` | Paths to EA LiDAR rasters for real LoS checks |
| `NEXT_PUBLIC_MAPTILER_KEY` | MapTiler base-map API key |
| `ELEVENLABS_API_KEY` | ElevenLabs voice API key (STT + TTS) |
