# NeMo-Ray — Nemotron ↔ Coverage-Twin Integration

> **Start-of-session handoff.** Companion to [`INTEGRATION.md`](./INTEGRATION.md).
> This doc is the plan for wiring the **Nemotron agent** (our lane, `modellingsim/`)
> to the **already-built coverage-twin** so the agent's tools run **real** Sionna RT
> + cuOpt instead of stubs. _Written 2026-06-06._
>
> ### ✅ Update 2026-06-06 (session 2) — cuOpt solve verified on this box
> `python -m src.optimize` **runs end-to-end here** against NVIDIA's hosted cuOpt and
> returns `Optimal` (`2 new masts, solve 0.10s`). The previously-unverified README
> claims are now confirmed. Setup that got it working:
> - Twin checked out at `../nemoray-twin` (git worktree, branch `ee-coverage-twin`).
> - **Minimal venv** (`../nemoray-twin/.venv`, Python 3.12) — `optimize.py` does **not**
>   import sionna/mitsuba/drjit, so we installed **only** `numpy geopandas shapely pyproj
>   scipy requests PyYAML osmium`. **No CUDA downgrade** → the local cuOpt server's libs
>   are untouched. (The heavy RT stack is only needed for the *verify* / *coverage* steps.)
> - `git lfs install` then `git lfs pull --include=data/buildings.pkl` (172 MB) — the
>   pickle cache `load_buildings()` reads; without it optimise dies. The `.osm.pbf` is
>   **not** needed when the pickle is present.
> - The committed **hosted cuOpt API key still works** (not yet rotated — ⚠️ still leaked).
> - ⚠️ **Committed-data inconsistency:** `out/optimization.json` (53 holes → 49 masts) was
>   produced by a *wider* run than the committed `out/hotspots.geojson` (9 features → only
>   2 outdoor after the in-building filter). The solve is real either way; just don't trust
>   the two committed files as a matched pair.
> ### ✅ Update 2026-06-06 (session 2, cont.) — full real pipeline + `run_cuopt` wired
> - **Heavy RT venv installed** in the twin worktree venv (`../nemoray-twin/.venv`):
>   `sionna-rt 2.0.1`, `mitsuba 3.8.0` (exposes `cuda_ad_*` variants), `drjit 1.3.1` all
>   import and the GPU is live. This venv is isolated from `modellingsim/`, so its CUDA
>   downgrade does **not** touch the local cuOpt server (which the twin doesn't use — it
>   calls **hosted** cuOpt over HTTP).
> - **Full pipeline verified over HTTP.** `POST /api/optimize` runs cuOpt (`Optimal`) **+**
>   Sionna RT *verify* (re-simulates the affected tiles on GPU): `verified: true`,
>   `served_pct_after ≈ 99.6%`, ~970 rays traced. Confirmed on **both** Mehul's running
>   copy (`/home/nvidia/Mehul`, port 8000) **and** our self-contained worktree
>   (`../nemoray-twin`, started on port **8011**) — we don't depend on Mehul's process.
> - **`run_cuopt` de-faked** ([`tools.py`](../modellingsim/src/nemoray_modelling/tools.py),
>   `_cuopt_via_twin`): **env-gated** by `TWIN_URL`. Unset/unreachable → the offline
>   fixture (CI + the scripted money-shot stay hermetic, smoke test PASSES). Set
>   (`TWIN_URL=http://localhost:8011`) → POST `/api/optimize` + GET `/out/new_masts.geojson`,
>   mapped into the same candidate shape. Verified: `run_cuopt` card now reads
>   *"cuOpt Optimal: N candidate mast(s); solve 0.05s; RT-verified, 99.77% served after."*
> - **Two caveats carried forward:**
>   1. **Twin `out/` is stateful** — `verify` overwrites `out/hotspots.geojson` with the
>      *remaining* holes, so back-to-back `/api/optimize` calls shrink the hole set (count
>      drifted 48→2 across two calls). Reset `out/` from git between demo runs if you want
>      a stable starting hole set.
>   2. **`exclude` only works on the `--live` path.** The scripted `OfflinePlanner`
>      hardcodes stub ids (`cow-westminster-A`), which don't match real ids (`new-0`), so
>      its retry doesn't filter. Real Nemotron reads the observation and excludes correctly.

---

## TL;DR — what changed our plan

We were about to **write** real cuOpt + Sionna from scratch. We don't need to.
A teammate (**Mehul**) already built a near-complete **EE 4G coverage & resilience
digital twin** on the orphan branch **`origin/ee-coverage-twin`**. It does **both**
halves, on **real data**, and ships **precomputed results**:

| Piece | Where | What it does |
| --- | --- | --- |
| Sionna RT coverage | `src/pipeline.py`, `src/rt.py` | real OSM London buildings → per-tile Mitsuba scenes → `RadioMapSolver` (GPU) → best-server RSS @ 25 m → **coverage holes** (`out/hotspots.geojson`) |
| cuOpt placement | `src/optimize.py`, `src/cuopt.py` | set-cover MILP over the holes (fewest masts, line-of-sight checks vs real buildings) → **proposed masts** (`out/new_masts.geojson`) |
| RT verification | `src/verify.py` | re-runs Sionna with the proposed masts added → proves the holes are fixed (`out/verification.json`) |
| HTTP server | `src/serve.py` | `POST /api/optimize` runs optimise (+ verify) and returns summary JSON; also serves a CesiumJS viewer |
| Precomputed data | `data/tiles/*/result.npz`, `out/*.geojson`, `out/*.json` | solved coverage + holes + proposals **committed** → cuOpt can run **without re-tracing** |

**So the modelling is done. The remaining work is the integration glue:** make the
Nemotron agent's stub tools call this twin.

---

## ⚠️ Before anything — security + environment flags

1. **Leaked secret.** `config.yaml` on `ee-coverage-twin` hard-codes a live NVIDIA
   API key: `cuopt.api_key: "nvapi-…"`. It is committed to the repo.
   **Action: rotate that key, move it to an env var (e.g. `CUOPT_API_KEY`), and
   stop committing it.** (The twin's cuOpt currently runs on NVIDIA's **hosted
   cloud**, authenticated by this key.)
2. **Orphan branch.** `ee-coverage-twin` has **no merge-base with `main`** — separate
   history, its own project layout at the repo root (`src/`, `viewer/`, `config.yaml`,
   its own `SITEFINDER_MAY_2012.csv`). It is **not** built on our `modellingsim/` +
   `nemoray/` tree. Treat it as a sibling project, not a feature branch to merge.
3. **Dependency conflict → separate venv.** The twin needs `sionna-rt`, `mitsuba`,
   `drjit` (its `requirements.txt`). Installing those **downgrades the CUDA libs the
   local `cuopt-server-cu13` depends on** (verified: `cuda-toolkit`, `nvidia-cublas`,
   `nccl`, `cusolver`, … all get pulled back). **Keep the twin in its own venv**,
   isolated from the `modellingsim/` agent venv. (Mehul's README uses
   `python -m venv --system-site-packages .venv`.)
4. **git-LFS.** `data/buildings.pkl` and `data/greater-london-latest.osm.pbf` are
   **LFS pointers** (134-byte stubs). `optimize.py` needs `buildings.pkl` for its
   line-of-sight tests → run **`git lfs pull`** after checkout. (`result.npz` tiles
   and `out/*.geojson` are committed directly — those are real already.)
5. **Missing dep.** `src/optimize.py` imports `scipy` (`from scipy.spatial import
   cKDTree`) but `scipy` is **not** in `requirements.txt`. Add it.

---

## Decisions taken

- **cuOpt backend:** use **Mehul's hosted cuOpt first** (it already works end-to-end),
  then **also test the local `cuopt-server-cu13`** as a follow-up. To switch later,
  repoint `src/cuopt.py` at the local server — the MILP payload schema is identical
  (CSR matrix + `objective_data` + `variable_types` + `solver_config`), only the
  HTTP client/URL/auth differ. The local server's solution lives at
  `response.solver_response.solution.vars` (same shape `read_solution` already parses).
- **Transport:** the agent reaches the twin over **HTTP to `src.serve`** (clean
  process/venv isolation; mirrors our existing FastAPI `/agent` bridge). Not subprocess.

---

## Target architecture

```
 modellingsim/ venv  (agent + local cuOpt)        ee-coverage-twin venv (Sionna + hosted cuOpt)
 ┌────────────────────────────────┐               ┌────────────────────────────────────────┐
 │  Nemotron ReAct agent          │               │  src.serve  (HTTP)                       │
 │  (agent.py, tools.py, server)  │   HTTP POST   │   • POST /api/optimize  → optimize+verify │
 │                                │ ────────────► │   • POST /api/coverage  → NEW: tower-down │
 │  tools:                        │               │                                          │
 │   • run_cuopt          ────────┼──────────────►│  optimize.optimize(cfg) → new_masts.geojson
 │   • run_sionna_coverage ───────┼──────────────►│  pipeline run, a mast disabled → hotspots │
 │   • validate_site      ────────┼──────────────►│  verify.verify(cfg)     → verification.json
 └────────────────────────────────┘               └────────────────────────────────────────┘
            │ AgentStreamEvent SSE (unchanged)
            ▼
   nemoray/ HUD  (NEXT_PUBLIC_USE_MOCK=false)
```

The agent tools translate the twin's geojson/summary JSON into the agent's
`ToolResult.observation` (fed back to Nemotron) + the FE's `AgentStreamEvent` frames.
**The FE wire protocol does not change** — we only fill the tool bodies.

> ### ✅ Update 2026-06-06 (session 2, cont.) — step 4 done: tower-down coverage wired
> - **New twin endpoint `POST /api/coverage`** (`src/coverage.py` + `src/serve.py` on the
>   twin worktree, **uncommitted** — needs to land on `ee-coverage-twin`). Body:
>   `{"disabled_site_ids": ["TQ…"]}`. Disables those masts, re-solves **only** the tiles
>   they illuminated (within `tx_radius`, reuses the cache for the rest), re-mosaics, and
>   re-exports `out/hotspots.geojson` + `out/coverage.json`. Verified: disabling City mast
>   `TQ3268080770` → holes **9 → ~64**, 4 of 16 tiles re-simulated, **~13 s**.
> - **`run_sionna_coverage` de-faked** (`tools.py` `_coverage_via_twin`): env-gated by
>   `TWIN_URL`, same pattern as `run_cuopt`. Falls back to the fixture when the twin is
>   unset/unreachable **or when nothing real was disabled** (so the scripted placeholder id
>   keeps CI hermetic). Real path maps `hotspots.geojson` → dead-zone list + summary.
> - **Canonical demo mast wired:** `TQ3268080770` (EE, City of London) now drives the
>   smoke-test scenario + the `OfflinePlanner`'s first tool call. Fixture mode ignores the
>   id (unchanged); with `TWIN_URL` set the offline script produces a **real** tower-down +
>   real cuOpt proposals end-to-end. The FE/`--live` path already carries the real `siteId`
>   via `server.py:_event_text`.
> - **Step 5 (`validate_site`) decision: keep the LiDAR fail→pass stub** (it's the W4/EA-
>   LiDAR lane — a *different* data source than RT, and the real RT verification already
>   runs inside `run_cuopt`'s `/api/optimize`). Building a per-site RT `/api/validate` was
>   considered but deferred: cuOpt only proposes sites that already clear LOS, so a real
>   per-site check would ~always PASS and kill the reject→retry demo beat.
> - **⚠️ Multi-call `run_cuopt` + stateful `out/`:** each `/api/optimize` runs verify,
>   which **overwrites `hotspots.geojson`** with the *remaining* holes. So a second
>   `run_cuopt` in the same run sees almost no holes left → returns no proposals → falls
>   back to the fixture. Takeaway: **with real data the natural flow is ONE `run_cuopt`
>   call** that returns an RT-verified set; the reject→retry→accept "money shot" is a
>   fixture-era narrative. For a clean real demo, drive a single optimise (or `git checkout
>   out/` between runs).
> - **Verified:** smoke test PASSES in fixture mode (money-shot intact) **and** with
>   `TWIN_URL=http://localhost:8011` (real Sionna RT tower-down + real RT-verified cuOpt
>   streamed through the agent loop). Ruff clean.

### How the scenario maps
- Mehul's `optimize.py` = "fewest **permanent** new masts to cover baseline holes"
  (set-cover, ≥1 coverage). Our scenario = "a tower **goes down** → place **mobile
  Starlink COWs** to restore coverage." Same mechanics (place transmitters to cover
  hole centroids via cuOpt MILP). Two deltas to add over time:
  - **Tower-down**: drop the failed mast from the set and re-run the coverage pass →
    the new holes. (New `/api/coverage` knob; Sionna side.)
  - **Framing** (optional later): max-coverage with a budget of *K* cars vs
    min-masts set-cover. Start by driving the existing `optimize()` as-is.

---

## Next-session steps (cuOpt first)

1. **Stand up the twin locally (its own venv).**
   ```bash
   git worktree add ../nemoray-twin ee-coverage-twin   # or check out the branch elsewhere
   cd ../nemoray-twin && git lfs pull                   # materialise buildings.pkl + .osm.pbf
   python3 -m venv --system-site-packages .venv && source .venv/bin/activate
   pip install -r requirements.txt scipy                # scipy is missing from requirements
   export CUOPT_API_KEY=...                             # rotated key; edit cuopt.py to read env
   python -m src.optimize                               # runs cuOpt off committed holes → out/new_masts.geojson
   python -m src.serve                                  # http://localhost:8000 ; POST /api/optimize
   ```
   Expect `out/optimization.json` with a real `new_masts` count + cuOpt status.

2. **De-fake `run_cuopt`** in `modellingsim/src/nemoray_modelling/tools.py`: replace the
   hard-coded body (lines ~176–204) with an HTTP `POST {TWIN_URL}/api/optimize`, then
   map `new_masts.geojson` (proposed positions) + `optimization.json` (holes covered,
   status, solve time) into `ToolResult.result` (the card string) and
   `ToolResult.observation` (the structured payload Nemotron reads). Keep the tool
   **interface** identical so the agent loop is untouched.

3. **Verify through the agent loop:**
   `uv run --package nemoray-modelling python modellingsim/smoke_test_agent.py`
   (offline planner, no GPU model) → the `run_cuopt` card now shows **real** proposals;
   loop still PASSES.

4. **Then the Sionna tool:** add `POST /api/coverage {disabled_site_ids}` to `src.serve`
   (re-run `pipeline` with those masts removed → fresh `hotspots.geojson`), and wire
   `run_sionna_coverage` to it. This also fills the `/coverage` 501 stub in
   `modellingsim/.../server.py` (W2).

5. **Then `validate_site` → `verify.verify(cfg)`** (RT-verified pass/fail + coverage gain).

6. **Follow-up — local cuOpt:** repoint `src/cuopt.py` at the local `cuopt-server-cu13`
   (start it as in `modellingsim/smoke_test_cuopt.py`), and compare hosted vs local.
   This restores the brief's **all-local-DGX-Spark** story.

---

## Files to open next time
- **Twin (`ee-coverage-twin` branch):** `src/optimize.py`, `src/cuopt.py`, `src/serve.py`,
  `src/pipeline.py`, `src/verify.py`, `config.yaml`, `requirements.txt`, `README.md`.
- **Agent (our lane, `arzaan1`):** `modellingsim/src/nemoray_modelling/tools.py`
  (stub bodies to replace), `agent.py` + `server.py` (loop + bridge — stable).
- **FE contract (reference only):** `nemoray/lib/types.ts` (`AgentStreamEvent`,
  `ToolCall`, `Proposal`), `nemoray/app/api/agent/route.ts` (the `${API_BASE}/agent` proxy).

## Done when
A plain-English outage chat to Nemotron drives a multi-step run that **calls the twin
for real** — real Sionna holes → real cuOpt proposals → real RT verification — streamed
to the HUD with `NEXT_PUBLIC_USE_MOCK=false`.
