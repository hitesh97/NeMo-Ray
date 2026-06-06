# NeMo-Ray — Integration Roadmap

> Status + plan for turning the storyboarded pipeline into a working system.
> Companion to [`BRIEF.md`](./BRIEF.md) (the vision) and [`JUDGING.md`](./JUDGING.md)
> (the rubric we're scored against). Living document — edit as pieces land.
> _Last updated 2026-06-06: W1 Nemotron agent built + validated live on the real
> GGUF; **all agent tools still return stubbed data** (see "Next session" below)._

The target pipeline:

```
 Ingest  ─►  Coverage twin  ─►  Optimise  ─►  Reality-check  ─►  Interactive UI
 (OpenCellID  (Sionna RT,        (cuOpt: where   (Nemotron agent:    (Next.js HUD +
  + OSM)       radio maps)         to add masts)   is this viable?)    proposals)
```

Today, the **frontend end is well advanced** — a polished UI whose mock↔real
seam is fully wired (both `/api/agent` SSE and `/api/coverage` already proxy
`${API_BASE}` when `USE_MOCK=false`), real London tower data is ingested
(SiteFinder EE-proxy), and an animated RF signal-path renderer exists. The
**Nemotron agent + its FastAPI `/agent` bridge now exist and run on the real
model** — but **all of the agent's tools return stubbed data**: no real Sionna,
no real cuOpt call, no real LiDAR validation, no closed loop over real data. This
doc tracks closing that gap.

---

## 0. Next session — pick up here

> **⚡ Major update (2026-06-06):** the cuOpt + Sionna modelling we were about to
> build **already exists** — teammate **Mehul** shipped a near-complete coverage
> twin on the orphan branch `origin/ee-coverage-twin` (real Sionna RT + cuOpt +
> precomputed results). The plan flipped from *build the tools* to *integrate the
> agent with the twin over HTTP*. **See [`TWIN_INTEGRATION.md`](./TWIN_INTEGRATION.md)
> — that is now the start-of-session plan.** (Note: it also flags a leaked NVIDIA
> API key committed in the twin's `config.yaml` — rotate it.)

**Where we are:** the W1 Nemotron agent is built and *validated live on the real
GGUF* (CLI + HTTP bridge), but it reasons over **fake senses** — every tool is a
stub in `modellingsim/src/nemoray_modelling/tools.py`. The orchestration is
proven; the pipeline outputs are theatre until the tools are real. One scenario
tested, once.

**Our plan (we're taking cuOpt + Sionna ourselves, not just handing off):**

1. **De-fake `run_cuopt` first** — the easiest real win; the cuOpt server already
   works. Replace `ToolRegistry._run_cuopt` with a real call, using
   `modellingsim/smoke_test_cuopt.py` as the client reference. Decide the
   formulation: COW **placement** (facility-location / max-coverage over candidate
   sites) rather than the survey-routing VRP the spike uses (see §5).
2. **Attempt `run_sionna_coverage` (W2)** — the real coverage twin. Blocker: needs
   a minimal London OSM building + terrain scene (W3 part b). Output real dead
   zones for the disabled cells → feed them to cuOpt. Same work fills the `POST
   /coverage` 501 stub in `server.py`.
3. **Harden + test the agent loop** — multiple outages, 0-dead-zone case, repeated
   validation failure, >2 candidates. Currently only the happy path is exercised.

**Still teammate-owned:** `validate_site` → W4 (EA LiDAR); `query_graph` /
`retrieve` → W5 (GraphRAG); FE `ToolName` union + `Proposal` unification.

**Files to open next time:**
- `modellingsim/src/nemoray_modelling/tools.py` — the stub bodies to replace.
- `modellingsim/smoke_test_cuopt.py` — working cuOpt client to copy from.
- `modellingsim/src/nemoray_modelling/{agent,server}.py` — loop + bridge (stable;
  touch only to harden / add tools).

**Run + verify:**
- Offline demo:  `uv run --package nemoray-modelling python modellingsim/smoke_test_agent.py`
- Live (model on :8080):  `… smoke_test_agent.py --live`
- Bridge (offline):  `NEMORAY_AGENT_OFFLINE=1 uv run --package nemoray-modelling uvicorn nemoray_modelling.server:app --port 8000`
- Start the model:  `/home/nvidia/llama.cpp/build/bin/llama-server --model <…Q4_K_XL.gguf> --port 8080 --n-gpu-layers 99 --ctx-size 8192`

---

## 1. Current state

### Built

| Area | What exists | Where |
| ---- | ----------- | ----- |
| Frontend HUD | Next.js 16 "AI-RAN Mission Control": 5 workspaces, Cesium 3D map, streaming agent console + tool pipeline, ElevenLabs voice, KPIs, scenario timeline, cuOpt proposal list with Nemotron verdict card. **Mock-driven** behind a `USE_MOCK` / `API_BASE` seam. | `nemoray/` |
| Backend seam (FE half) | The swap is real on the frontend: `/api/agent` streams `AgentStreamEvent` SSE (mock-replay or proxy `${API_BASE}/agent`); `/api/coverage` returns `RadioMap` (mock-compute or proxy `${API_BASE}/coverage`); `/api/proposals/stream` SSE drives the proposal camera tour; voice routes (`/api/voice/*`). | `nemoray/app/api/`, `nemoray/lib/config.ts`, `nemoray/lib/api/coverage.ts` |
| Data ingest (partial) | Real **SiteFinder London EE-proxy** mast dataset (~9.2k rows) ingested: typed parser, `/api/sitefinder` filter route, Cesium tower layer + selection hook, unit tests. (SiteFinder, **not** OpenCellID; see W3.) | `data/retrieved/SITEFINDER_London_EEproxy.csv`, `nemoray/lib/data/sitefinder.ts`, `nemoray/types/sitefinder.ts`, `nemoray/components/cesium/SitefinderTowerLayer.tsx` |
| Coverage contract + RF render | `RadioMap`/`CoverageCell`/`DeadZone` types, a mock Sionna stand-in + local recompute, and an animated signal-path layer subsystem (geometry/material/particles) with tests. | `nemoray/types/coverage.ts`, `nemoray/lib/mock/radioMap.ts`, `nemoray/lib/data/mockSionna.ts`, `nemoray/lib/cesium/signal/` |
| **Nemotron agent (W1)** | **Real tool-calling ReAct agent**: simulate → optimise → validate → reject → re-prompt → accept, emitting `AgentStreamEvent` frames. Tools stubbed behind a registry; offline + live planners; end-to-end smoke test. | `modellingsim/src/nemoray_modelling/{agent,tools,events}.py`, `smoke_test_agent.py` |
| **Nemotron HTTP bridge** | **FastAPI serving `POST /agent` SSE** (+ `/health`); `/coverage` left as a 501 stub for W2. The Python half of the W6 `/agent` seam — `USE_MOCK=false` reaches it directly. | `modellingsim/src/nemoray_modelling/server.py` |
| cuOpt spike | Working toy VRP against the cuOpt server (4 sites, 2 vans). cuOpt server (`cuopt-server-cu13`) installed in `modellingsim/`. | `modellingsim/smoke_test_cuopt.py` |
| Nemotron translator | Single-shot call to local llama.cpp (Nemotron-3-Nano-Omni-30B, Q4); plain-English event → structured JSON. Kept as a helper alongside the agent. | `modellingsim/src/nemoray_modelling/nemotron.py` |

### Not yet built

1. **Sionna RT** — entirely absent. "sionna" appears only in docs + mock data.
   No coverage-twin code. This is the sim engine *and* a core Technical-Depth pillar.
2. **Data ingest is partial** — SiteFinder EE-proxy masts are in (above), but
   there's still **no OpenCellID** (UK MCC `234`, EE MNCs `20`/`30`), **no OSM
   building geometry**, and **no terrain** — i.e. nothing yet feeds a Sionna
   scene. SiteFinder gives us towers to draw, not a sim input.
3. **Backend server** — `/agent` is now served by the FastAPI bridge (above); the
   remaining hole is **`POST /coverage`** (the W2/Sionna endpoint, currently a 501
   stub) and any further endpoints teammates need.
4. **Real reality-check** — the LiDAR/StreetView validation source is still a
   `TODO`. The verdict reasons in the UI are a hard-coded array of plausible
   strings (`REJECTION_REASONS` in `nemoray/lib/data/mockProposals.ts`).
5. **The loop doesn't close** — cuOpt input is a toy matrix (not Sionna dead
   zones); Nemotron output isn't wired to cuOpt; cuOpt output isn't validated.
6. **Mismatched contracts — now on *both* sides.**
   - **Python ↔ frontend:** Nemotron's Python JSON (`affected_cells`,
     `cow_candidates`, `validation_checks`) is unrelated to the frontend's
     `AgentStreamEvent` / `ToolCall` / `Proposal` shapes.
   - **Frontend ↔ frontend:** there are now **two divergent `Proposal` types** in
     the UI — the rich one in `nemoray/lib/types.ts`
     (`position`, `coverageGainPct`, `estCostGbp`, `validation.source`) and a flat
     one in `nemoray/types/coverage.ts` (`lat`, `lng`, `score`, `accepted`,
     `reason`) that the mocks (`mockProposals.ts`, `/api/proposals/stream`)
     actually emit. These must be unified *before* picking a canonical backend
     contract (W6).

### How Nemotron is wired *today*

- **Python:** a real **tool-calling ReAct agent** now exists
  (`modellingsim/src/nemoray_modelling/agent.py` + `tools.py` + `events.py`). It
  runs the simulate → optimise → validate → reject → re-prompt → accept loop and
  yields the frontend's `AgentStreamEvent` frames. Tools (`run_sionna_coverage`,
  `run_cuopt`, `validate_site`) are **stubbed** behind a clean registry; an
  `OfflinePlanner` runs the loop with no GPU, `LlamaCppPlanner` drives the real
  model. The original one-shot `chat()` translator (`nemotron.py`) is kept as a
  helper. See W1 below for what remains.
- **HTTP:** a FastAPI bridge (`modellingsim/src/nemoray_modelling/server.py`) now
  **serves** `POST /agent` as `AgentStreamEvent` SSE — the exact shape the FE's
  `/api/agent` proxies. `NEXT_PUBLIC_USE_MOCK=false NEXT_PUBLIC_API_BASE=…` drives
  the real agent through the HUD today (offline mode needs no GPU).
- **Frontend:** fully scripted SSE replay (`lib/mock/agent.ts`); real mode pipes
  to `${API_BASE}/agent`, which the FastAPI bridge above now answers.

So the **Best Use of Nemotron** bounty loop is *implemented, served, and validated
live on the real model* — but **against stubbed tool data** (see the reality-check
callout under W1). The remaining gap is making the tools real: we take `run_cuopt`
and `run_sionna_coverage` ourselves (§0), `validate_site` stays with W4.

---

## 2. Target architecture

```
                         ┌─────────────────────────────────────────┐
                         │            modellingsim/ (DGX Spark)      │
  OpenCellID ─┐          │                                           │
  OSM bldgs  ─┼─► ingest ─► Sionna RT ──► radio map / dead zones ──┐ │
  EA LiDAR  ─┘          │                                          │ │
                         │   ┌──────────── Nemotron AGENT ◄────────┘ │
                         │   │  tools:                                │
                         │   │   • run_sionna_coverage                │
                         │   │   • run_cuopt        ───► cuOpt server │
                         │   │   • validate_site    ───► LiDAR LoS    │
                         │   │   • query_graph (KG) ───► networkx     │
                         │   │   • retrieve (RAG)   ───► vector DB    │
                         │   └──────────────┬─────────────────────── │
                         │      FastAPI:  /agent (SSE)  /coverage     │
                         └──────────────────┼─────────────────────── │
                                            │  AgentStreamEvent SSE
                                            ▼
                         nemoray/  (NEXT_PUBLIC_USE_MOCK=false)
```

The frontend already speaks this protocol; the work is to make `modellingsim/`
serve it for real.

---

## 3. Workstreams

Ordered by leverage against the rubric. Each is independently demoable.

### W1 — Nemotron as a real tool-calling agent  ★ highest leverage

**Why:** converts the weakest scored area into the strongest; it's the bounty.

**Done (Nemotron lane complete for the demo):**
- ✅ ReAct loop (simulate → optimise → validate → *reject → re-prompt cuOpt →
  accept*) in `agent.py`, driven by a strict JSON-action protocol.
- ✅ Emits the frontend's `AgentStreamEvent` frames (`events.py`) — no ad-hoc JSON.
- ✅ Tool registry with stubbed `run_sionna_coverage` / `run_cuopt` / `validate_site`
  (`tools.py`); `OfflinePlanner` (GPU-free) + `LlamaCppPlanner` (real model, with a
  JSON-repair retry).
- ✅ **FastAPI `/agent` SSE bridge** (`server.py`) — `USE_MOCK=false` runs the agent
  through the real HUD.
- ✅ `smoke_test_agent.py` runs the whole reject→retry→accept loop end-to-end.
- ✅ **Validated live on the real Nemotron GGUF** (2026-06-06) — both the CLI
  (`--live`) and the FastAPI bridge over HTTP ran the full loop. The model parsed
  NL→args, read each observation, and *chose* to exclude the failed site and retry;
  `<think>` blocks didn't break JSON extraction.

> ⚠️ **Reality check — what's real vs mocked.**
> **REAL:** the model, the loop, the reasoning, the SSE/HTTP bridge.
> **MOCKED:** *every tool's data.* `run_sionna_coverage` returns 2 hard-coded dead
> zones; `run_cuopt` returns 2 hard-coded rooftops (**the cuOpt server is never
> called**); `validate_site` is rigged to fail call #1 and pass call #2. So
> Nemotron reasons *correctly over fake senses* — orchestration proven, pipeline
> outputs are theatre until the tools are real. Only one scenario, tested once.

**Remaining for W1 — we're taking cuOpt + Sionna ourselves (see §0):**
- [ ] **De-fake `run_cuopt`** → call the real cuOpt server. *(us)*
- [ ] **De-fake `run_sionna_coverage`** (W2) → real dead zones; also fills `/coverage`. *(us)*
- [ ] **Harden + test the loop** across varied scenarios / edge cases. *(us)*
- [ ] **Add `query_graph` / `retrieve` tools** once W5 exists. *(us, after W5)*

**Still teammate-owned (swap a stub body in `tools.py`, interface stays put):**
- `validate_site` → **W4 (LiDAR)**: real LoS check, returns pass/fail + reason.
- Add `run_sionna_coverage` to the FE `ToolName` union in `lib/types.ts` →
  **frontend** (§1.6; renders today regardless, this is for type-correctness).

**Done when:** a plain-English outage drives a multi-step run that actually calls
cuOpt and the validator *with real data*, with real accept/reject reasoning,
streamed to the UI.

### W2 — Sionna RT coverage twin

**Why:** the sim engine; Technical Depth + Performance points; makes coverage real.
**What:**
- Build the scene from OSM buildings over the London bbox
  (`[[-0.510, 51.286], [0.334, 51.686]]`).
- Place transmitters from ingested EE LTE masts (W3).
- Compute radio maps; derive dead zones (threshold on path gain / RSRP).
- Reference: NVlabs `sionna-large-radio-maps`.

**Done when:** `recomputeCoverage` returns a real `RadioMap` (cells + deadZones)
for the live mast set, and re-runs with a mast disabled (the "money shot").

### W3 — Data ingest

**Why:** real inputs; without it everything downstream is synthetic.
**Status:** SiteFinder EE-proxy masts are ingested and drawn (see §1 Built). The
remaining gap is (a) optionally cross-checking/replacing with OpenCellID, and
(b) the **building + terrain geometry** Sionna needs — SiteFinder gives towers,
not a scene.
**What:**
- OpenCellID `234.csv` → filter LTE + EE MNCs (`20`, `30`) → mast set
  (reconcile against the existing SiteFinder set; decide which is canonical).
- OSM buildings (+ terrain) for the Sionna scene. **← the actual blocker for W2.**
- Cross-check vs Ofcom / CellMapper for sanity.
- Map the ingested masts onto the canonical `Site[]` in `nemoray/lib/types.ts`
  (the SiteFinder parser currently emits its own `types/sitefinder.ts` shape).

**Done when:** the UI's `sites` come from real ingested data mapped to `Site[]`,
**and** OSM building/terrain geometry is available to build a Sionna scene.

### W4 — Real LiDAR validation (use EA LiDAR, not StreetView)

**Why:** makes the signature insight *true* and keeps it **local** (Spark story).
**What:**
- **UK Environment Agency LiDAR composite** (1 m DSM + DTM, open, downloadable —
  no API, no cloud, no paywall).
- `validate_site(lat, lng, target)`: sample the DSM along the LoS path; canopy
  height = DSM − DTM; flag obstruction / vegetation; return pass/fail + reason +
  source. Far stronger than Google StreetView Insights, which is cloud + paywalled
  and *breaks* the local story.

**Done when:** rejections cite a measured obstruction (e.g. "14 m canopy at 80 m
breaks LoS") computed from real elevation data, surfaced in `ValidationVerdict`.

### W5 — GraphRAG add-ons (vector DB + knowledge graph)

The rubric explicitly names **RAG** under Technical Depth, so this scores directly
— not gold-plating.

**Vector DB / RAG — grounds the *reasoning*.**
- Index planning + RF knowledge: Ofcom siting rules, heritage/exclusion zones,
  ICNIRP RF-exposure limits, ESN's 97%-landmass requirement, mast-height limits.
- Nemotron *retrieves and cites* a real rule on rejection instead of inventing
  one.
- Keep **local**: Qdrant / Chroma / FAISS on-box, ideally with an **NVIDIA NeMo
  Retriever / embedding NIM** so the stack stays NVIDIA + local.

**Knowledge graph — unlocks the non-obvious insight (Insight Quality).**
- Model: `mast → cell → coverage cell → emergency facility (police/fire/ambulance)
  → backhaul/power dependency`.
- Answers *"if this mast fails, which 999 facilities lose ESN coverage, and what
  cascades?"* — the "not traffic-jams-at-5pm" insight the rubric rewards.
- For a hackathon: **networkx in-memory + a `query_graph` tool**. Don't reach for
  Neo4j.

**Combine as GraphRAG:** graph for topology/dependency, vectors for regulatory
text → a clean "novel combination" for Creativity points.

**Done when:** Nemotron's verdicts cite retrieved rules, and a failure query
returns the affected-facility cascade from the graph.

### W6 — FastAPI bridge + contract reconciliation

**Why:** lights up `USE_MOCK=false`; this is the seam that ties everything together.
**Status:** the **frontend half is done** (`/api/agent`, `/api/coverage`,
`/api/proposals/stream` proxy `${API_BASE}` when `USE_MOCK=false`) **and the
Python `POST /agent` half is now served** by the FastAPI bridge (`server.py`,
W1). What's left: **`POST /coverage`** on the Python side (W2) + contract
reconciliation.
**What:**
- ✅ FastAPI app in `modellingsim/` with `POST /agent` → `AgentStreamEvent` SSE.
- [ ] `POST /coverage` `{scenarioId, deactivatedSiteIds[]}` → `RadioMap` (W2/Sionna;
  currently a 501 stub in `server.py`).
- [ ] Reconcile the Python JSON schema with `nemoray/lib/types.ts`
  (`AgentStreamEvent` / `ToolCall` / `Proposal`). Pick the frontend contract as
  canonical; adapt the Python side. **First unify the two FE `Proposal` types**
  (§1.6) so "the frontend contract" is unambiguous.

**Done when:** `NEXT_PUBLIC_USE_MOCK=false NEXT_PUBLIC_API_BASE=...` runs the full
pipeline through the real HUD with no component changes. *(The `/agent` path works
today; `/coverage` lights up once W2 lands.)*

### W7 — Spark story numbers

**Why:** 15 pts ("why this runs better on a DGX Spark"), currently a `TODO`.
**What:** run Sionna + Nemotron + vector index + graph concurrently; record
unified-memory footprint, sim resolution, real-time speedup, tokens/s. The
128 GB "holds sim buffers + LLM context + graph at once" claim must be *measured*,
not asserted.

---

## 4. Suggested sequencing

A spine that's demoable at every step:

1. **W6 (Python bridge — FE half already done)** + **W1 (agent loop, tools
   stubbed)** — stand up the FastAPI server emitting `AgentStreamEvent`; flip
   `USE_MOCK=false` for a real streaming agent end-to-end, even before the tools
   are real. Lowest-effort, highest-leverage step now that the FE seam exists.
   Unlocks the bounty narrative.
2. **W3 (ingest)** → **W2 (Sionna)** — real coverage flows into the UI.
3. **W4 (LiDAR)** + **W1 wired to cuOpt** — the reality-check loop becomes true.
4. **W5 (GraphRAG)** — depth + the headline insight.
5. **W7** — capture numbers for the pitch.

Steps 1–3 alone move every "incomplete/mock" line above into "real" and satisfy
*Completeness*, *The Stack*, and *Best Use of Nemotron*.

---

## 5. Open decisions

- **OpenCellID vs the ingested SiteFinder set** — keep SiteFinder as canonical,
  add OpenCellID, or cross-validate one against the other? And map the chosen set
  onto `Site[]` (`lib/types.ts`) vs the current `types/sitefinder.ts` shape.
- **Unify the two frontend `Proposal` types** (`lib/types.ts` vs
  `types/coverage.ts`) — prerequisite for W6 contract reconciliation (§1.6).
- Exact London bbox + EE MNC set for the Sionna scene (bbox/MNCs noted in
  `nemoray/CLAUDE.md`; confirm the sim subset).
- Vector store choice (Qdrant vs Chroma vs FAISS) + embedding model (NeMo
  Retriever NIM vs local sentence-transformers).
- Graph store (networkx in-memory assumed; revisit only if persistence needed).
- Whether the ElevenLabs voice bounty (persistent ≥ 1h11m) is in scope.
- cuOpt problem framing: COW *placement* (facility-location / max-coverage) vs the
  current survey-routing VRP — placement is the brief's intent.
