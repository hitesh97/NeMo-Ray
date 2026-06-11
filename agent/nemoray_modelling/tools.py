"""
Tool registry for the Nemotron resilience agent.

Every tool drives a real backend or real data — there are no scripted fixtures:

    run_sionna_coverage / simulate_outage / move_mast / deploy_cow
        → the coverage twin (`src/serve.py`, TWIN_URL) — Sionna RT re-simulation.
          With the twin down, coverage tools degrade to the pipeline's real
          artifacts (hotspots/masts/new_masts .geojson) and say so in `source`.
    run_cuopt       → the twin's /api/optimize (NVIDIA cuOpt MILP + RT verify).
    validate_site   → EA National LiDAR Programme rasters (auto-fetched from the
                      EA WCS around the candidate and cached under data/lidar/).
    check_starlink  → Skyfield over live CelesTrak Starlink TLEs (see tle.py).
    find_nearest / locate_place / nearby_places / describe_network / find_masts
        → the spatial knowledge graph (places.py) + the London emergency CSVs.

A tool returns a `ToolResult`:
  • `result`      — a short human string shown on the frontend tool card.
  • `observation` — the structured payload fed back to the model next turn.
  • `ui_actions`  — map directives (highlights / camera) streamed to the HUD.

When a backend is unreachable AND no real artifact can answer, the tool returns
an honest error observation (never invented numbers) telling the operator what
to start. ``observation["source"]`` always names where the figures came from;
a ``[NeMo-Ray DEGRADED] <tool>: <reason>`` stderr line flags any degradation.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any


# ── map directives (UI geometry) ────────────────────────────────────────────────
# Tools attach a list of map_action `action` dicts to their ToolResult.ui_actions; the agent
# loop streams each as a map_action frame the HUD reduces (see nemoray/lib/types.ts MapAction).
# Coordinates are WGS84 [lng, lat]. These helpers build the action dicts.
def _feature_bbox(feat: dict[str, Any]) -> list[float] | None:
    """[minLng, minLat, maxLng, maxLat] of a (Multi)Polygon GeoJSON feature, or None."""
    geom = feat.get("geometry") or {}
    t = geom.get("type")
    coords = geom.get("coordinates") or []
    rings: list[list[list[float]]] = []
    if t == "Polygon":
        rings = coords
    elif t == "MultiPolygon":
        rings = [ring for poly in coords for ring in poly]
    pts = [pt for ring in rings for pt in ring if len(pt) >= 2]
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def _union_bbox(bboxes: list[list[float]]) -> list[float] | None:
    bboxes = [b for b in bboxes if b]
    if not bboxes:
        return None
    return [
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    ]


def _warn_degraded(tool: str, reason: str) -> None:
    """Announce on stderr that `tool` degraded from its primary backend (e.g. live twin →
    pipeline artifact, or an honest error), and why. The machine-readable counterpart is
    ``observation["source"]``, which always names where the figures came from. Keep `reason`
    short and specific so a live-run console makes the failure obvious."""
    print(
        f"[NeMo-Ray DEGRADED] {tool}: {reason}",
        file=sys.stderr,
        flush=True,
    )


# ── pre-rendered outages (mast positions + per-scenario id sets) ──────────────────
def _box_polygon(lng: float, lat: float, h: float = 0.0035) -> dict[str, Any]:
    """A small square GeoJSON Polygon (~h° half-width, ≈500–700 m) centred on (lng, lat)."""
    ring = [[lng - h, lat - h], [lng + h, lat - h],
            [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h]]
    return {"type": "Polygon", "coordinates": [ring]}


def _repo_root() -> Path:
    """Repo root (holds the nemoray app + data/). Overridable with NEMORAY_ROOT."""
    env = os.environ.get("NEMORAY_ROOT")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / "nemoray" / "public" / "raytracing").is_dir() or (
            p / "data" / "emergency"
        ).is_dir():
            return p
    return here.parents[2]


@lru_cache(maxsize=1)
def _mast_positions() -> dict[str, list[float]]:
    """Map mast id → [lng, lat] from the pipeline's masts.geojson (the live copy under
    nemoray/public/raytracing, else the committed out/ seed), so an outage can draw its
    dead zones where the downed masts actually stood. Returns {} when absent."""
    root = _repo_root()
    path = None
    for rel in ("nemoray/public/raytracing/masts.geojson", "out/masts.geojson"):
        p = root / rel
        if p.exists():
            path = p
            break
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception:
        return {}
    out: dict[str, list[float]] = {}
    for f in data.get("features", []):
        try:
            mid = f["properties"]["id"]
            lng, lat = f["geometry"]["coordinates"][:2]
        except (KeyError, ValueError, TypeError):
            continue
        out[str(mid)] = [float(lng), float(lat)]
    return out


def _zones_for_sites(site_ids: list[str]) -> list[dict[str, Any]]:
    """Dead-zone features centred on each downed mast's real position (a coverage hole opens
    where the mast was). Empty when no position resolves (artifact missing) → caller returns an
    honest error."""
    pos = _mast_positions()
    feats: list[dict[str, Any]] = []
    for sid in site_ids:
        p = pos.get(str(sid))
        if not p:
            continue
        feats.append({
            "type": "Feature",
            "properties": {"id": f"dz-{sid}", "severity": "critical"},
            "geometry": _box_polygon(p[0], p[1]),
        })
    return feats


# How close a coverage hole must sit to a downed mast to count as part of *this* outage. The
# twin's out/hotspots.geojson lists EVERY hole in the scene (the baseline dead zones, with or
# without the outage); without this clip an outage would report dead zones — and place a COW —
# across the whole city instead of the chunk around the masts that actually went down.
OUTAGE_ZONE_RADIUS_KM = 1.5


def _zones_near_sites(
    feats: list[dict[str, Any]],
    site_ids: list[str],
    radius_km: float = OUTAGE_ZONE_RADIUS_KM,
) -> list[dict[str, Any]]:
    """Keep only the dead-zone features within `radius_km` of one of the downed masts, so an
    outage's holes (and the COW deployed for them) cluster at the incident rather than spanning
    every baseline hole the twin returns scene-wide. Returns [] when nothing is near (the caller
    falls back to drawing zones at the masts); passes everything through if no mast resolves."""
    from .emergency import feature_centroid, haversine_km

    pos = _mast_positions()
    pts = [pos[str(s)] for s in site_ids if pos.get(str(s))]
    if not pts:
        # No downed-mast position resolved — return nothing rather than the whole scene's
        # holes, so a missing artifact can never strand a COW across the city. Callers fall
        # back to drawing zones at the masts, then to an honest error.
        return []
    out: list[dict[str, Any]] = []
    for f in feats:
        c = feature_centroid(f)  # (lng, lat)
        if not c:
            continue
        if any(haversine_km(c[1], c[0], p[1], p[0]) <= radius_km for p in pts):
            out.append(f)
    return out


# Pre-rendered outages, one per HUD scenario (nemoray/lib/scenarios.ts Scenario.outage.siteIds).
# The ids are real EE/Orange masts from masts.geojson clustered over each incident's epicentre,
# so "simulate the scenario's outage" opens holes in a believable place with no operator
# selection. Keep this in sync with the frontend's seedDeactivated/outage ids.
OUTAGE_CATALOG: dict[str, list[str]] = {
    "high-demand": ["TQ3263381285", "TQ3250081280", "TQ3248081251"],
    "major-event": ["TQ3776480097", "TQ3755080270", "TQ3776079840"],
    "infrastructure-loss": ["TQ3070081830", "TQ3054081790", "TQ3064081980"],
    "power-outage": ["TQ3448082620", "TQ3483082690", "TQ3481082720"],
}
# Used when the operator selected nothing and gave no (or the nominal "live") scenario.
DEFAULT_OUTAGE_SCENARIO = "infrastructure-loss"


def resolve_outage_site_ids(
    site_ids: list[str] | None, scenario: str | None = None
) -> list[str]:
    """The masts an outage should disable: the explicit selection if any, else the active
    scenario's pre-rendered set, else the default. Never empty — so the agent always has a real
    outage to simulate (this is what kills the old empty-ids → placeholder loop)."""
    if site_ids:
        return list(site_ids)
    if scenario and scenario in OUTAGE_CATALOG:
        return list(OUTAGE_CATALOG[scenario])
    return list(OUTAGE_CATALOG[DEFAULT_OUTAGE_SCENARIO])


# Human-facing labels for the tool cards (mirrors TOOL_LABELS in lib/mock/agent.ts).
TOOL_LABELS: dict[str, str] = {
    "run_sionna_coverage": "Run Sionna Coverage",
    "run_cuopt": "Run cuOpt",
    "validate_site": "Validate Site",
    "simulate_outage": "Simulate Mast Outage",
    "move_mast": "Relocate Mast",
    "deploy_cow": "Deploy Cell-on-Wheels",
    "check_starlink": "Check Starlink Backhaul",
    "find_nearest": "Find Nearest Service",
    "locate_place": "Locate Place",
    "nearby_places": "Scan Surroundings",
    "describe_network": "Network Overview",
    "find_masts": "Find Masts",
    "clear_proposals": "Clear Proposed Masts",
}


@dataclass
class ToolResult:
    result: str
    observation: dict[str, Any]
    # Map directives for the HUD (map_action `action` dicts) — highlight zones/buildings,
    # place the COW + source station, fly the camera. Empty for tools with no UI effect.
    ui_actions: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema for the args object
    run: Callable[..., ToolResult]

    @property
    def label(self) -> str:
        return TOOL_LABELS.get(self.name, self.name)


class ToolRegistry:
    """Holds the agent's tools + any per-run state (call counts)."""

    # The operator's most recent spatial reference — the COW just deployed or the place
    # just located. CLASS-level so it survives across runs (a ToolRegistry is built per
    # run): a follow-up turn like "what's around it?" or "check starlink" can then default
    # to the spot the previous turn established instead of central London.
    _last_cow: dict[str, Any] | None = None

    def __init__(self) -> None:
        self._calls: dict[str, int] = {}
        self._specs: dict[str, ToolSpec] = {}
        self._register_defaults()

    # ── public API ────────────────────────────────────────────────────────────
    def specs(self) -> list[ToolSpec]:
        return list(self._specs.values())

    def get(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def openai_tools(self) -> list[dict[str, Any]]:
        """Tool schemas in OpenAI/llama.cpp `tools` format (for native tool-calling)."""
        return [
            {
                "type": "function",
                "function": {
                    "name": s.name,
                    "description": s.description,
                    "parameters": s.parameters,
                },
            }
            for s in self._specs.values()
        ]

    def run(self, name: str, args: dict[str, Any]) -> ToolResult:
        spec = self._specs.get(name)
        if spec is None:
            return ToolResult(
                result=f"Unknown tool: {name}",
                observation={"error": f"no such tool '{name}'"},
            )
        self._calls[name] = self._calls.get(name, 0) + 1
        return spec.run(args or {})

    # ── tool implementations ────────────────────────────────────────────────────
    def _register_defaults(self) -> None:
        self._add(
            "run_sionna_coverage",
            "Run the Sionna RT coverage twin over the London scene with the given "
            "cells disabled. Returns the resulting dead zones (coverage holes).",
            {
                "type": "object",
                "properties": {
                    "disabled_cells": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Cell ids to disable before simulating.",
                    }
                },
                "required": ["disabled_cells"],
            },
            self._run_sionna_coverage,
        )
        self._add(
            "run_cuopt",
            "Ask cuOpt for the best new mast (COW) placement to fill the given dead "
            "zones. Optionally exclude previously-rejected candidate locations.",
            {
                "type": "object",
                "properties": {
                    "dead_zone_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Dead zones to cover.",
                    },
                    "exclude": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Candidate ids to exclude (already rejected).",
                    },
                },
                "required": ["dead_zone_ids"],
            },
            self._run_cuopt,
        )
        self._add(
            "validate_site",
            "Validate a candidate mast site against EA LiDAR: sample the line-of-sight "
            "path and report whether terrain/canopy breaks coverage. Returns pass/fail.",
            {
                "type": "object",
                "properties": {
                    "candidate_id": {"type": "string"},
                    "lat": {"type": "number"},
                    "lng": {"type": "number"},
                },
                "required": ["lat", "lng"],
            },
            self._validate_site,
        )
        self._add(
            "simulate_outage",
            "Simulate one or more existing masts going offline (a breakdown). Re-runs the "
            "Sionna RT coverage twin with those sites disabled and reports the new dead "
            "zones AND which emergency-service buildings (police, fire, hospitals) fall "
            "inside them and therefore lose service. Call with no site_ids to simulate the "
            "active scenario's pre-rendered outage.",
            {
                "type": "object",
                "properties": {
                    "site_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Existing mast/site ids to take offline. Omit to use "
                        "the active scenario's pre-rendered outage.",
                    }
                },
                "required": [],
            },
            self._simulate_outage,
        )
        self._add(
            "move_mast",
            "Relocate an existing mast to operator-provided coordinates: disable it at its "
            "old site and place it at the new lat/lng, then re-simulate the affected tiles "
            "and report the resulting coverage.",
            {
                "type": "object",
                "properties": {
                    "site_id": {"type": "string", "description": "Id of the mast to move."},
                    "new_lat": {"type": "number"},
                    "new_lng": {"type": "number"},
                    "height_m": {"type": "number", "description": "Optional antenna height."},
                },
                "required": ["site_id", "new_lat", "new_lng"],
            },
            self._move_mast,
        )
        self._add(
            "deploy_cow",
            "Find the best deployment for a Cell-on-Wheels during an outage. One COW is "
            "garaged at each fire station and can be towed up to 3 km, so it picks the "
            "dead zone that both protects the most emergency-service buildings and sits "
            "within tow range of a station, places a 20 m COW mast there, and (with the "
            "twin) verifies how many coverage holes it closes.",
            {
                "type": "object",
                "properties": {
                    "disabled_site_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "The masts that are down (outage context to verify).",
                    },
                    "max_km": {"type": "number", "description": "Max tow distance (default 3)."},
                    "height_m": {"type": "number", "description": "COW height (default 20)."},
                    "scenario": {
                        "type": "string",
                        "description": "Active scenario id — selects the outage's dead zones "
                        "when disabled_site_ids is omitted.",
                    },
                    "keep_overlay": {
                        "type": "boolean",
                        "description": "Keep the outage's dead-zone + affected-building "
                        "highlights on the map instead of clearing them (use after "
                        "simulate_outage so the full incident stays painted).",
                    },
                },
                "required": [],
            },
            self._deploy_cow,
        )
        self._add(
            "check_starlink",
            "Identify the Starlink satellite that will backhaul a deployed Cell-on-Wheels. A "
            "COW has no fibre, so it uplinks to whichever Starlink satellite is best overhead. "
            "Pass the COW's lat/lng (defaults to the COW just placed by deploy_cow). Returns "
            "the best visible satellite (name, elevation, slant range) or none in view.",
            {
                "type": "object",
                "properties": {
                    "lat": {"type": "number", "description": "COW latitude (default: last COW)."},
                    "lng": {"type": "number", "description": "COW longitude (default: last COW)."},
                },
                "required": [],
            },
            self._check_starlink,
        )
        self._add(
            "find_nearest",
            "Find the nearest emergency-service building (hospital, police station or fire "
            "station) to a point and highlight it on the operator's map. Use this for 'where "
            "is the nearest X' / 'show me the closest X' questions. Defaults the reference "
            "point to the last-placed COW, else central London.",
            {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["hospital", "police", "fire"],
                        "description": "Which kind of emergency service to locate.",
                    },
                    "lat": {"type": "number", "description": "Reference latitude (optional)."},
                    "lng": {"type": "number", "description": "Reference longitude (optional)."},
                },
                "required": ["kind"],
            },
            self._find_nearest,
        )
        self._add(
            "locate_place",
            "Point the operator's camera at a NAMED place from the knowledge graph and "
            "highlight it: a London landmark, area, transport hub, stadium, park, museum or "
            "government building (e.g. 'Tower Bridge', 'Canary Wharf', \"King's Cross\"), OR a "
            "named emergency-service building (e.g. \"Guy's Hospital\", 'Charing Cross Police "
            "Station'). Use this whenever the operator says 'show me X', 'fly to X', 'where is "
            "X', 'take me to X' for a place that has a name. Resolves fuzzy/partial names.",
            {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The place name to find (landmark, area, station, "
                        "hospital, etc.). Partial/approximate names are resolved.",
                    },
                    "category": {
                        "type": "string",
                        "enum": [
                            "area", "landmark", "attraction", "transport", "stadium", "park",
                            "museum", "government", "hospital", "police", "fire",
                        ],
                        "description": "Optional: restrict resolution to one category (e.g. "
                        "'hospital' to disambiguate a hospital name).",
                    },
                    "zoom": {"type": "number", "description": "Optional camera zoom override."},
                },
                "required": ["query"],
            },
            self._locate_place,
        )
        self._add(
            "nearby_places",
            "List what's AROUND a place or point and frame the camera on the cluster — the "
            "knowledge-graph neighbourhood. Give a place name ('near the Shard') or lat/lng, an "
            "optional radius, and optional category filter, to get the nearest landmarks and "
            "emergency services with distances. Use for 'what's near X', 'what hospitals are "
            "around X', 'what's in this area'. Call with NO query for pronoun follow-ups "
            "('what's around it/there?') — it automatically scans around the operator's most "
            "recent reference: the place just located or the COW just deployed. ALWAYS still "
            "pass `categories` when the operator asks for a specific kind ('any hospitals "
            "near there?' → categories:['hospital']) — without it, closer landmarks can crowd "
            "the kind they asked about out of the list. (For the single closest service of "
            "one kind, prefer find_nearest.)",
            {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Place name to centre on (resolved via the knowledge "
                        "graph). Omit to use lat/lng or the last-placed COW.",
                    },
                    "lat": {"type": "number", "description": "Centre latitude (if no query)."},
                    "lng": {"type": "number", "description": "Centre longitude (if no query)."},
                    "radius_km": {"type": "number", "description": "Search radius (default 1.5)."},
                    "categories": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": [
                                "area", "landmark", "attraction", "transport", "stadium",
                                "park", "museum", "government", "hospital", "police", "fire",
                            ],
                        },
                        "description": "Optional category filter (e.g. ['hospital','fire']).",
                    },
                },
                "required": [],
            },
            self._nearby_places,
        )
        self._add(
            "describe_network",
            "Summarise the simulated ESN network the same way the operator's dashboard does: "
            "how many EE masts, modelled buildings and radio cells, the % served, the number of "
            "coverage holes (dead zones), and the GPU/ray-tracing telemetry — and frame the "
            "camera over the whole simulated area. Use for 'how big is the network', 'what's "
            "the coverage', 'give me a network overview / status'.",
            {"type": "object", "properties": {}, "required": []},
            self._describe_network,
        )
        self._add(
            "find_masts",
            "Report the EE/Orange masts (cell towers) the dashboard shows AROUND a place or "
            "point, or look up ONE mast by id, and frame the camera on them. Give a place name "
            "('masts near the Shard'), lat/lng, or a mast_id. Returns how many masts, their "
            "operators, heights and bands. Use for 'how many masts are around X', 'what masts "
            "cover this area', 'tell me about mast <id>', 'show me the towers near X'.",
            {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Place name to centre on (resolved via the knowledge "
                        "graph). Omit to use lat/lng, a mast_id, or the last-located point.",
                    },
                    "mast_id": {
                        "type": "string",
                        "description": "Look up a single mast by its exact id and fly to it.",
                    },
                    "lat": {"type": "number", "description": "Centre latitude (if no query)."},
                    "lng": {"type": "number", "description": "Centre longitude (if no query)."},
                    "radius_km": {"type": "number", "description": "Search radius (default 0.8)."},
                    "operator": {
                        "type": "string",
                        "description": "Optional operator filter (e.g. 'EE', 'Orange').",
                    },
                },
                "required": [],
            },
            self._find_masts,
        )
        self._add(
            "clear_proposals",
            "Remove ALL proposed masts (the cuOpt plan) and their rays from the map and "
            "restore the baseline network state. Use when the operator says 'remove the "
            "proposed masts', 'clear the plan', 'reject the proposals', 'reset', or "
            "'start over'. This reverts the optimisation only — the real mast network is "
            "untouched.",
            {"type": "object", "properties": {}, "required": []},
            self._clear_proposals,
        )

    def _add(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        run: Callable[..., ToolResult],
    ) -> None:
        self._specs[name] = ToolSpec(name, description, parameters, run)

    def _run_sionna_coverage(self, args: dict[str, Any]) -> ToolResult:
        # Primary: TWIN_URL set → POST /api/coverage to re-run Sionna RT with the given masts
        # disabled (tower-down → fresh holes). With the twin down, degrade to the REAL coverage
        # holes the pipeline wrote (hotspots.geojson — exactly the dashboard heatmap's dead
        # zones). With neither, return an honest error — never invented zones.
        disabled = list(args.get("disabled_cells", []) or [])
        twin = os.environ.get("TWIN_URL", "").rstrip("/")
        if twin:
            real = self._coverage_via_twin(twin, disabled)  # warns on its own degradation
            if real is not None:
                return real
        else:
            _warn_degraded("run_sionna_coverage", "TWIN_URL not set")
        from .places import load_hotspots

        hs = load_hotspots()
        if hs:
            dead_zones = [
                {"id": h["id"],
                 "centroid": [round(h["centroid"][0], 5), round(h["centroid"][1], 5)],
                 "severity": h["severity"]}
                for h in hs
            ]
            zone_dirs = [
                {"id": h["id"], "bbox": [round(x, 6) for x in h["bbox"]],
                 "severity": h["severity"]}
                for h in hs
            ]
            zaction: dict[str, Any] = {"op": "zones", "zones": zone_dirs}
            ub = _union_bbox([h["bbox"] for h in hs])
            if ub:
                zaction["focus"] = {"bbox": [round(x, 6) for x in ub], "pitch": 35}
            return ToolResult(
                result=f"{len(dead_zones)} dead zones across the simulated area "
                f"(from the Sionna RT coverage map) — highlighted on the map",
                observation={
                    "disabled_cells": disabled,
                    "dead_zone_count": len(dead_zones),
                    "dead_zones": dead_zones[:8],
                    "source": "coverage artifact (hotspots.geojson)",
                },
                ui_actions=[{"op": "clear"}, zaction],
            )
        # No twin and no artifact: be honest about it.
        _warn_degraded("run_sionna_coverage", "no twin and no hotspots.geojson artifact")
        return ToolResult(
            result="Coverage data unavailable — start the coverage twin (python -m src.serve) "
            "or run the pipeline (python -m src.pipeline) first.",
            observation={
                "error": "no coverage backend",
                "detail": "TWIN_URL unreachable and hotspots.geojson absent",
                "source": "none",
            },
        )

    def _coverage_via_twin(self, twin: str, disabled: list[str]) -> ToolResult | None:
        """Re-run the twin's coverage with `disabled` masts removed; map the resulting
        out/hotspots.geojson into dead zones. Returns None when the twin errors or nothing
        real was disabled, so the caller degrades to the pipeline artifact."""
        import httpx

        try:
            with httpx.Client(base_url=twin, timeout=600.0) as client:
                r = client.post("/api/coverage", json={"disabled_site_ids": disabled})
                r.raise_for_status()
                summary = r.json()
                g = client.get("/out/hotspots.geojson")
                g.raise_for_status()
                feats = g.json().get("features", [])
        except Exception as exc:
            _warn_degraded("run_sionna_coverage", f"twin /api/coverage unreachable ({exc!r})")
            return None

        # Nothing real disabled (e.g. an unknown cell id) → degrade to the artifact.
        if not summary.get("disabled_matched"):
            _warn_degraded("run_sionna_coverage", "no disabled cell matched a known twin site")
            return None

        dead_zones = []
        for i, f in enumerate(feats):
            geom = f.get("geometry", {})
            coords = geom.get("coordinates") or []
            if not coords:
                continue
            ring = coords[0][0] if geom.get("type") == "MultiPolygon" else coords[0]
            if not ring:
                continue
            clng = sum(c[0] for c in ring) / len(ring)
            clat = sum(c[1] for c in ring) / len(ring)
            dead_zones.append({
                "id": f"dz-{i:02d}",
                "centroid": [round(clng, 5), round(clat, 5)],
                "severity": "major",
            })
        holes = summary.get("coverage_holes", len(dead_zones))
        served = summary.get("served_pct")
        tiles = summary.get("tiles_resimulated")
        return ToolResult(
            result=f"{holes} dead zones after disabling "
            f"{', '.join(summary['disabled_matched'])} "
            f"({tiles} tiles re-simulated, {served}% served) via Sionna RT",
            observation={
                "disabled_cells": disabled,
                "disabled_matched": summary.get("disabled_matched"),
                "disabled_unknown": summary.get("disabled_unknown"),
                "dead_zones": dead_zones,
                "summary": summary,
                "source": "Sionna RT coverage twin",
            },
        )

    def _run_cuopt(self, args: dict[str, Any]) -> ToolResult:
        # Primary: TWIN_URL set → drive the coverage twin — POST /api/optimize runs the cuOpt
        # set-cover MILP (+ RT verify) and writes new_masts.geojson, which we map into candidate
        # proposals. With the twin down, degrade to the REAL cuOpt plan the pipeline last wrote
        # (new_masts.geojson). With neither, return an honest error — never invented candidates.
        exclude = set(args.get("exclude", []) or [])
        twin = os.environ.get("TWIN_URL", "").rstrip("/")
        if twin:
            real = self._cuopt_via_twin(twin, exclude)  # warns on its own degradation
            if real is not None:
                return real
        else:
            _warn_degraded("run_cuopt", "TWIN_URL not set")
        candidates = self._cuopt_candidates_from_artifact()
        source = "cuOpt output artifact (new_masts.geojson)"
        if not candidates:
            _warn_degraded("run_cuopt", "no twin and no new_masts.geojson artifact")
            return ToolResult(
                result="No cuOpt plan available — start the coverage twin (python -m src.serve) "
                "or run the pipeline with --opt to generate one.",
                observation={
                    "error": "no optimiser backend",
                    "detail": "TWIN_URL unreachable and new_masts.geojson absent",
                    "source": "none",
                },
            )
        avail = [c for c in candidates if c["candidate_id"] not in exclude] or candidates
        pick = max(avail, key=lambda c: c.get("covers_holes") or 0)
        n = len(candidates)
        return ToolResult(
            result=f"cuOpt proposes {n} new mast(s) to fill the dead zones; recommended: "
            f"{pick['label']} (+{round(pick['coverage_gain_pct'] * 100)}% coverage, "
            f"£{pick['est_cost_gbp']:,})",
            observation={
                "candidate": pick,
                "candidates": self._lean_candidates(candidates),
                "candidate_count": n,
                "source": source,
            },
            ui_actions=self._candidates_ui(candidates, pick),
        )

    @staticmethod
    def _candidates_ui(
        candidates: list[dict[str, Any]], pick: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Map directive for a cuOpt run: a gold 'proposal' marker for EVERY candidate mast (the
        full optimiser plan), the recommended pick labelled, and the camera framed over the whole
        set. (Previously only the single pick was shown, which read as 'cuOpt picks one spot'
        even though it places many — the bug this fixes.)"""
        pick_id = pick.get("candidate_id")
        markers: list[dict[str, Any]] = []
        for i, c in enumerate(candidates):
            is_pick = c.get("candidate_id") == pick_id
            marker: dict[str, Any] = {
                "id": str(c.get("candidate_id", f"cand-{i}")),
                "position": [c["lng"], c["lat"]],
                "kind": "proposal",
            }
            if is_pick:
                gain = round((c.get("coverage_gain_pct") or 0) * 100)
                marker["label"] = c.get("label", "Recommended mast")
                marker["detail"] = f"+{gain}% coverage · recommended"
            markers.append(marker)
        lngs = [c["lng"] for c in candidates]
        lats = [c["lat"] for c in candidates]
        if len(candidates) > 1:
            pad = 0.004
            focus: dict[str, Any] = {
                "bbox": [round(min(lngs) - pad, 6), round(min(lats) - pad, 6),
                         round(max(lngs) + pad, 6), round(max(lats) + pad, 6)],
                "pitch": 40,
            }
        else:
            focus = {"center": [pick["lng"], pick["lat"]], "zoom": 14.5, "pitch": 45}
        return [{"op": "markers", "markers": markers, "focus": focus}]

    @staticmethod
    def _lean_candidates(
        candidates: list[dict[str, Any]], cap: int = 60
    ) -> list[dict[str, Any]]:
        """Compact candidate list for the HUD's Optimiser panel (and a lean LLM observation) —
        just the fields a Proposal card needs."""
        return [
            {"candidate_id": c.get("candidate_id"), "label": c.get("label"),
             "lat": c["lat"], "lng": c["lng"],
             "coverage_gain_pct": c.get("coverage_gain_pct"),
             "est_cost_gbp": c.get("est_cost_gbp"), "covers_holes": c.get("covers_holes")}
            for c in candidates[:cap]
        ]

    # Per-COW capex placeholder until a real cost model lands — the twin returns no cost.
    _COW_COST_GBP = 80000

    def _cuopt_candidates_from_artifact(self) -> list[dict[str, Any]]:
        """Build cuOpt candidates from the pipeline's real optimiser output (new_masts.geojson +
        optimization.json) — the genuine multi-mast plan — used when the live twin is down."""
        from .places import load_optimization_summary, load_proposed_masts

        masts = load_proposed_masts()
        if not masts:
            return []
        total = max(int(load_optimization_summary().get("coverage_holes") or len(masts)), 1)
        out: list[dict[str, Any]] = []
        for m in masts:
            covers = int(m.get("covers_holes") or 1)
            cid = m["id"]
            out.append({
                "candidate_id": cid,
                "label": f"Proposed mast {cid} — covers {covers} dead-zone cell(s)",
                "lat": m["lat"], "lng": m["lng"],
                "coverage_gain_pct": round(covers / total, 3),
                "est_cost_gbp": self._COW_COST_GBP,
                "covers_holes": covers,
            })
        return out

    def _cuopt_via_twin(self, twin: str, exclude: set[str]) -> ToolResult | None:
        """Drive the real coverage-twin over HTTP and map its cuOpt proposals into the same
        candidate shape the artifact path returns. Returns None on any failure so the
        caller degrades to the pipeline artifact."""
        import httpx

        try:
            with httpx.Client(base_url=twin, timeout=600.0) as client:
                r = client.post("/api/optimize")
                r.raise_for_status()
                summary = r.json()
                g = client.get("/out/new_masts.geojson")
                g.raise_for_status()
                feats = g.json().get("features", [])
        except Exception as exc:
            _warn_degraded("run_cuopt", f"twin /api/optimize unreachable ({exc!r})")
            return None

        total = max(int(summary.get("coverage_holes") or len(feats)), 1)
        candidates: list[dict[str, Any]] = []
        for f in feats:
            try:
                lng, lat = f["geometry"]["coordinates"]
                p = f.get("properties", {})
            except (KeyError, ValueError, TypeError):
                continue
            covers = int(p.get("covers_holes", 1))
            cid = p.get("id")
            candidates.append({
                "candidate_id": cid,
                "label": f"Proposed COW {cid} — covers {covers} dead-zone cell(s)",
                "lat": float(lat),
                "lng": float(lng),
                # No per-mast gain from the MILP; approximate by share of holes served.
                "coverage_gain_pct": round(covers / total, 3),
                "est_cost_gbp": self._COW_COST_GBP,
                "covers_holes": covers,
            })
        if not candidates:
            _warn_degraded("run_cuopt", "twin returned no candidate masts")
            return None

        avail = [c for c in candidates if c["candidate_id"] not in exclude] or candidates
        pick = max(avail, key=lambda c: c.get("covers_holes") or 0)
        status = summary.get("status", "?")
        bits = [f"cuOpt {status}: {len(candidates)} candidate mast(s)"]
        if summary.get("solve_time_s") is not None:
            bits.append(f"solve {summary['solve_time_s']}s")
        if summary.get("verified"):
            bits.append(f"RT-verified, {summary.get('served_pct_after')}% served after")
        return ToolResult(
            result=f"cuOpt proposes {len(candidates)} new mast(s); recommended: {pick['label']} "
            f"({'; '.join(bits)})",
            observation={
                "candidate": pick,
                "candidates": self._lean_candidates(candidates),
                "candidate_count": len(candidates),
                "summary": summary,
                "source": "cuOpt (NVIDIA hosted MILP) via coverage-twin",
            },
            ui_actions=self._candidates_ui(candidates, pick),
        )

    # Cached EA-LiDAR backends. The env-configured rasters (LIDAR_DSM/LIDAR_DTM) load once;
    # otherwise tiles are auto-fetched from the EA WCS around each candidate and cached on
    # disk (data/lidar/auto/) + in-process. Class-level so the cache survives across the
    # per-run ToolRegistry instances.
    _lidar: Any = None
    _lidar_tried = False
    _lidar_auto: dict[str, Any] = {}

    # Candidates within the same 200 m grid cell share one auto-fetched 600 m tile, which
    # covers validate_en's 80 m sampling radius with ample margin at the cell edges.
    _AUTO_GRID_M = 200.0
    _AUTO_HALF_M = 300.0

    def _get_lidar(self):
        """Lazily load the env-configured LiDAR rasters (LIDAR_DSM/LIDAR_DTM), or None."""
        if self._lidar_tried:
            return self._lidar
        self._lidar_tried = True
        dsm, dtm = os.environ.get("LIDAR_DSM"), os.environ.get("LIDAR_DTM")
        if dsm and dtm and os.path.exists(dsm) and os.path.exists(dtm):
            try:
                from .lidar import LidarLOS
                self._lidar = LidarLOS(dsm, dtm)
            except Exception:
                self._lidar = None
        return self._lidar

    def _get_lidar_for(self, lat: float, lng: float):
        """A LidarLOS raster pair covering (lat, lng): the env-configured rasters when they
        cover the point, else an EA National LiDAR Programme tile auto-fetched from the EA
        WCS around it (cached on disk and in-process). None only when the configured rasters
        miss AND the WCS fetch fails (offline / outside EA coverage)."""
        from .lidar import LidarLOS, _wgs84_to_en, fetch_tiles

        e, n = _wgs84_to_en(lng, lat)
        configured = self._get_lidar()
        if configured is not None and configured.covers(e, n):
            return configured
        g = self._AUTO_GRID_M
        ce = (e // g) * g + g / 2
        cn = (n // g) * g + g / 2
        key = f"{ce:.0f}_{cn:.0f}"
        if key in self._lidar_auto:
            return self._lidar_auto[key]
        tile_dir = _repo_root() / "data" / "lidar" / "auto"
        dsm = tile_dir / f"dsm_{key}.tif"
        dtm = tile_dir / f"dtm_{key}.tif"
        los = None
        try:
            if not (dsm.exists() and dtm.exists()):
                h = self._AUTO_HALF_M
                fetch_tiles(ce - h, cn - h, ce + h, cn + h, str(dsm), str(dtm), timeout=120.0)
            los = LidarLOS(str(dsm), str(dtm))
        except Exception as exc:
            _warn_degraded("validate_site", f"EA LiDAR WCS fetch failed for tile {key} ({exc!r})")
            los = None
        self._lidar_auto[key] = los
        return los

    def _validate_site(self, args: dict[str, Any]) -> ToolResult:
        """Genuine EA-LiDAR overshadowing check on the candidate's lat/lng (DSM/DTM rasters,
        auto-fetched from the EA WCS when not configured locally). Returns an honest 'unknown'
        verdict when no terrain data can be obtained — never a scripted pass/fail."""
        lat, lng = args.get("lat"), args.get("lng")
        if lat is None or lng is None:
            return ToolResult(
                result="validate_site needs the candidate's lat/lng.",
                observation={"error": "missing lat/lng",
                             "candidate_id": args.get("candidate_id")},
            )
        lat, lng = float(lat), float(lng)
        lidar = self._get_lidar_for(lat, lng)
        if lidar is not None:
            v = lidar.validate_latlng(lat, lng)
            if v is not None:
                v["candidate_id"] = args.get("candidate_id")
                return ToolResult(
                    result=f"{v['verdict'].upper()} — {v['reason']}",
                    observation={**v, "source": "EA-LiDAR (overshadowing)"},
                )
            _warn_degraded("validate_site", "no valid terrain data at the candidate (nodata)")
        return ToolResult(
            result="Could not validate this site — EA LiDAR terrain data is unavailable here "
            "(offline, or the location falls outside the EA LiDAR coverage).",
            observation={
                "verdict": "unknown",
                "error": "no terrain data",
                "candidate_id": args.get("candidate_id"),
                "source": "none",
            },
        )

    # ── shared twin helpers (used by outage / move / COW) ───────────────────────
    @staticmethod
    def _twin_url() -> str:
        return os.environ.get("TWIN_URL", "").rstrip("/")

    @staticmethod
    def _post_coverage(
        twin: str, disabled: list[str], added: list[dict[str, Any]] | None = None
    ) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
        """POST /api/coverage (tower-down + optional added masts) and fetch the resulting
        hole polygons. Returns (summary, geojson_features) or None on any failure."""
        import httpx

        try:
            with httpx.Client(base_url=twin, timeout=600.0) as client:
                r = client.post(
                    # trace_rays=True so the twin re-traces the affected-tile rays in the
                    # same pass — every network change recomputes AND ships its rays.
                    "/api/coverage",
                    json={"disabled_site_ids": disabled, "added": added or [],
                          "trace_rays": True},
                )
                r.raise_for_status()
                summary = r.json()
                g = client.get("/out/hotspots.geojson")
                g.raise_for_status()
                feats = g.json().get("features", [])
            return summary, feats
        except Exception:
            return None

    @staticmethod
    def _fetch_twin_holes(twin: str) -> list[dict[str, Any]] | None:
        import httpx

        try:
            with httpx.Client(base_url=twin, timeout=120.0) as client:
                g = client.get("/out/hotspots.geojson")
                g.raise_for_status()
                return g.json().get("features", [])
        except Exception:
            return None

    @staticmethod
    def _summarise_buildings(affected: list[dict[str, Any]]) -> dict[str, int]:
        counts = {"police": 0, "fire": 0, "hospital": 0}
        for b in affected:
            counts[b["kind"]] = counts.get(b["kind"], 0) + 1
        return counts

    # ── new resilience tools ────────────────────────────────────────────────────
    def _simulate_outage(self, args: dict[str, Any]) -> ToolResult:
        """Breakdown of existing mast(s) → new dead zones + the emergency-service buildings
        inside them. Primary: the twin (Sionna RT tower-down re-simulation). With the twin
        down, the dead zones are drawn at the downed masts' real positions (masts.geojson) —
        the hole opens where the mast stood — and labelled as an estimate. With no
        site_ids it simulates the active scenario's pre-rendered outage (never a no-op)."""
        from .emergency import buildings_in_zones, feature_centroid

        explicit = args.get("site_ids") or args.get("disabled_cells") or []
        site_ids = resolve_outage_site_ids(
            list(explicit) if explicit else None, args.get("scenario")
        )
        twin = self._twin_url()
        source = ""
        summary: dict[str, Any] = {}
        feats: list[dict[str, Any]] = []

        if twin:
            res = self._post_coverage(twin, list(site_ids))
            if res is not None and res[0].get("disabled_matched"):
                summary, feats = res
                # Clip the twin's scene-wide holes to the outage neighbourhood — otherwise every
                # scenario reports the same city-wide dead zones (and emergency buildings right
                # across London) instead of the chunk around the masts that went down.
                feats = _zones_near_sites(feats, site_ids) or _zones_for_sites(site_ids) or feats
                source = "Sionna RT coverage twin"

        if not source:
            _warn_degraded(
                "simulate_outage",
                "TWIN_URL not set" if not twin else "twin unreachable or no site matched",
            )
            # Draw the holes where the downed masts actually stood (real positions from
            # masts.geojson); without even that artifact there is nothing real to show.
            feats = _zones_for_sites(site_ids)
            source = "downed-mast positions (masts.geojson; twin offline — zone extent estimated)"
            if not feats:
                return ToolResult(
                    result="Cannot simulate the outage — the coverage twin is unreachable and "
                    "no mast inventory (masts.geojson) is present. Start the twin "
                    "(python -m src.serve) or run the pipeline first.",
                    observation={
                        "error": "no coverage backend",
                        "disabled_cells": list(site_ids),
                        "detail": "TWIN_URL unreachable and masts.geojson absent",
                        "source": "none",
                    },
                )

        affected = buildings_in_zones(feats)
        counts = self._summarise_buildings(affected)
        dead_zones = []
        for i, f in enumerate(feats):
            c = feature_centroid(f)
            props = f.get("properties", {})
            dead_zones.append({
                "id": props.get("id") or f"dz-{i:02d}",
                "centroid": [round(c[0], 5), round(c[1], 5)] if c else None,
                "severity": props.get("severity", "major"),
            })

        n_aff = len(affected)
        bits = ", ".join(f"{v} {k}" for k, v in counts.items() if v)
        result = (
            f"{len(site_ids)} mast(s) offline → {len(dead_zones)} dead zone(s); "
            f"{n_aff} emergency-service building(s) lose coverage"
            + (f" ({bits})" if bits else "")
        )
        # ── map directives: paint the dead-zone ground (a bbox per hole) + the affected
        # emergency buildings, and fit the camera to the whole outage extent. Geometry rides
        # here, NOT in the observation, so the LLM context stays lean.
        zone_dirs: list[dict[str, Any]] = []
        for i, f in enumerate(feats):
            bb = _feature_bbox(f)
            if not bb:
                continue
            props = f.get("properties", {})
            zone_dirs.append({
                "id": props.get("id") or f"dz-{i:02d}",
                "bbox": [round(x, 6) for x in bb],
                "severity": props.get("severity", "major"),
            })
        zone_dirs = zone_dirs[:300]
        building_markers = [
            {"id": f"aff-{j}", "position": [b["lng"], b["lat"]], "kind": "building",
             "label": b["name"], "detail": b["kind"].title()}
            for j, b in enumerate(affected)
        ]
        ui: list[dict[str, Any]] = [{"op": "clear"}]
        if zone_dirs:
            zaction: dict[str, Any] = {"op": "zones", "zones": zone_dirs}
            ub = _union_bbox([zd["bbox"] for zd in zone_dirs])
            if ub:
                zaction["focus"] = {"bbox": [round(x, 6) for x in ub], "pitch": 35}
            ui.append(zaction)
        if building_markers:
            ui.append({"op": "markers", "markers": building_markers})

        # Observation feeds the LLM's next turn — keep it lean (a 65-zone dump blows the
        # context window). Cap the dead-zone list; the building hits are the salient signal.
        return ToolResult(
            result=result,
            observation={
                "disabled_cells": list(site_ids),
                "dead_zone_count": len(dead_zones),
                "dead_zones": dead_zones[:8],
                "affected_buildings": [
                    {"name": b["name"], "kind": b["kind"], "distance_m": b.get("distance_m")}
                    for b in affected
                ],
                "affected_counts": counts,
                "served_pct": summary.get("served_pct"),
                "tiles_resimulated": summary.get("tiles_resimulated"),
                "source": source,
            },
            ui_actions=ui,
        )

    def _move_mast(self, args: dict[str, Any]) -> ToolResult:
        """Relocate a mast: disable the old id, add it back at the new lat/lng, re-simulate."""
        site_id = args.get("site_id")
        lat = args.get("new_lat", args.get("lat"))
        lng = args.get("new_lng", args.get("lng"))
        if lat is None or lng is None or not site_id:
            return ToolResult(
                result="move_mast needs site_id, new_lat, new_lng",
                observation={"error": "missing site_id/new_lat/new_lng"},
            )
        lat, lng = float(lat), float(lng)
        added = [{"id": f"{site_id}-relocated", "lat": lat, "lng": lng}]
        if args.get("height_m") is not None:
            added[0]["height_m"] = float(args["height_m"])

        twin = self._twin_url()
        if twin:
            res = self._post_coverage(twin, [site_id], added)
            if res is not None and (res[0].get("disabled_matched") or res[0].get("added")):
                summary = res[0]
                holes = summary.get("coverage_holes")
                served = summary.get("served_pct")
                tiles = summary.get("tiles_resimulated")
                return ToolResult(
                    result=f"Moved {site_id} → ({lat:.5f}, {lng:.5f}): {holes} dead zone(s), "
                    f"{served}% served ({tiles} tiles re-simulated) via Sionna RT",
                    observation={
                        "site_id": site_id,
                        "new_position": {"lat": lat, "lng": lng},
                        "summary": summary,
                        "source": "Sionna RT coverage twin",
                    },
                )
            _warn_degraded("move_mast", "twin unreachable or neither old/new mast matched")
        else:
            _warn_degraded("move_mast", "TWIN_URL not set")
        # A relocation IS a re-simulation — without the twin there is nothing real to report.
        return ToolResult(
            result=f"Cannot relocate {site_id} — the coverage twin is unreachable, and a move "
            "requires a real Sionna RT re-simulation. Start it with python -m src.serve.",
            observation={
                "error": "no coverage backend",
                "site_id": site_id,
                "requested_position": {"lat": lat, "lng": lng},
                "source": "none",
            },
        )

    def _deploy_cow(self, args: dict[str, Any]) -> ToolResult:
        """Pick the best Cell-on-Wheels deployment: a dead zone within tow range of a fire
        station that protects the most emergency-service buildings; place a 20 m COW and (with
        the twin) verify how many holes it closes."""
        from .emergency import (
            COW_COVERAGE_KM,
            COW_HEIGHT_M,
            COW_MAX_KM,
            buildings_within_radius,
            feature_centroid,
            haversine_km,
            load_emergency_buildings,
            load_fire_stations,
            nearest_depot,
            restoration_eta,
        )

        disabled = resolve_outage_site_ids(
            list(args.get("disabled_site_ids") or []) or None, args.get("scenario")
        )
        max_km = float(args.get("max_km", COW_MAX_KM))
        height = float(args.get("height_m", COW_HEIGHT_M))
        radius_km = COW_COVERAGE_KM

        twin = self._twin_url()
        twin_holes = self._fetch_twin_holes(twin) if twin else None
        # The dead zone opens AT the masts that went down, so anchor the COW candidates on the
        # downed masts' real positions first — accurate by construction, and it matches the dead
        # zones simulate_outage painted. The twin's hotspots.geojson is the *baseline* scene-wide
        # hole set (not recomputed for this outage), so it's only a fallback when no downed-mast
        # position resolves (e.g. masts.geojson absent) — and even then clipped to near the
        # outage, never scene-wide (which would strand the COW wherever the city's holes cluster).
        mast_zones = _zones_for_sites(disabled)
        holes = _zones_near_sites(twin_holes, disabled) if (twin_holes and not mast_zones) else None
        feats = mast_zones or holes or []
        if not twin_holes:
            _warn_degraded(
                "deploy_cow",
                "TWIN_URL not set" if not twin else "twin returned no holes / unreachable",
            )
        if not feats:
            return ToolResult(
                result="Cannot place a Cell-on-Wheels — no dead zones are known for this "
                "outage (the coverage twin is unreachable and no mast inventory is present). "
                "Start the twin (python -m src.serve) or run the pipeline first.",
                observation={
                    "error": "no dead zones",
                    "disabled_cells": list(disabled),
                    "detail": "no twin holes and no masts.geojson positions",
                    "source": "none",
                },
            )
        depots = list(load_fire_stations())
        buildings = list(load_emergency_buildings())

        # Candidate COW positions are the dead-zone centroids. Cache each centroid so we can
        # also count how many *other* holes fall inside a candidate's coverage disc.
        cells = [(i, f, feature_centroid(f)) for i, f in enumerate(feats)]
        candidates = []
        for i, f, c in cells:
            if not c:
                continue
            clng, clat = c
            depot, km = nearest_depot(clat, clng, depots)
            # A parked COW serves everything inside its redistribution radius — not just the
            # single hole it sits on. Score by buildings (and holes) within COW_COVERAGE_KM.
            protected = buildings_within_radius(clat, clng, radius_km, buildings)
            holes_in_range = sum(
                1 for (_, _, oc) in cells
                if oc and haversine_km(clat, clng, oc[1], oc[0]) <= radius_km
            )
            candidates.append({
                "dead_zone_id": (f.get("properties", {}) or {}).get("id") or f"dz-{i:02d}",
                "lat": round(clat, 5),
                "lng": round(clng, 5),
                "buildings_protected": len(protected),
                "holes_in_range": holes_in_range,
                "depot": depot,
                "tow_km": round(km, 2),
                "reachable": km <= max_km,
            })

        reachable = [c for c in candidates if c["reachable"]]
        if not reachable:
            nearest = min((c["tow_km"] for c in candidates), default=None)
            return ToolResult(
                result=f"No dead zone within {max_km:.0f} km of a fire station "
                f"(closest {nearest} km) — a COW cannot reach it; consider a permanent mast.",
                observation={"candidates": candidates, "max_km": max_km, "feasible": False},
            )

        # Best = protects most buildings within its 2 km reach, ties broken by holes covered
        # then shortest tow.
        best = max(
            reachable,
            key=lambda c: (c["buildings_protected"], c["holes_in_range"], -c["tow_km"]),
        )
        cow = {
            "id": "COW-1",
            "lat": best["lat"],
            "lng": best["lng"],
            "height_m": height,
            "coverage_radius_km": radius_km,
        }
        ToolRegistry._last_cow = cow

        verified = None
        if twin:
            res = self._post_coverage(twin, disabled, [cow])
            if res is not None:
                after = res[0].get("coverage_holes")
                before = len(feats)
                verified = {
                    "holes_before": before,
                    "holes_after": after,
                    "served_pct_after": res[0].get("served_pct"),
                    "tiles_resimulated": res[0].get("tiles_resimulated"),
                }
            else:
                _warn_degraded("deploy_cow", "twin unreachable — COW hole-closure not verified")

        depot = best["depot"]
        # Traffic-aware restoration ETA: how long until the COW is on-site and serving — drive
        # from the depot (great-circle tow × road factor, scaled by current traffic) + dispatch
        # + setup. Same model as nemoray/lib/geo/restoration.ts drives the scenario timeline.
        eta = restoration_eta(best["tow_km"])
        tail = (
            f"holes {verified['holes_before']}→{verified['holes_after']} after COW"
            if verified else "set TWIN_URL to verify hole closure via Sionna RT"
        )
        # Observation feeds the LLM — send the decision + a small ranked shortlist, NOT the
        # full per-hole candidate list (one entry per dead zone overflows the context).
        shortlist = [
            {"dead_zone_id": c["dead_zone_id"], "tow_km": c["tow_km"],
             "buildings_protected": c["buildings_protected"], "station": c["depot"]["name"]}
            for c in sorted(reachable, key=lambda c: (-c["buildings_protected"], c["tow_km"]))[:5]
        ]
        # ── map directives: mark the source fire station (where to retrieve the COW from),
        # the COW drop point + its coverage disc, and the tow line between them; fly there. ──
        cow_marker = {
            "id": "cow-1", "position": [cow["lng"], cow["lat"]], "kind": "cow",
            "label": "Cell-on-Wheels", "detail": f"{radius_km:.1f} km coverage",
            "radiusKm": radius_km,
        }
        station_marker = {
            "id": "cow-source", "position": [depot["lng"], depot["lat"]], "kind": "station",
            "label": depot["name"], "detail": f"COW source · {best['tow_km']} km tow",
        }
        # keep_overlay layers the COW on top of the outage zones + affected-building markers
        # (the scenario macro sets it) instead of wiping them — so the final map shows the dead
        # zone, the emergency buildings hit, AND the COW + its source station together.
        ui: list[dict[str, Any]] = []
        if not args.get("keep_overlay"):
            ui.append({"op": "clear"})
        ui.append({
            "op": "cow",
            "cow": cow_marker,
            "station": station_marker,
            "route": [[depot["lng"], depot["lat"]], [cow["lng"], cow["lat"]]],
            "focus": {"center": [cow["lng"], cow["lat"]], "zoom": 13.5, "pitch": 45},
        })
        return ToolResult(
            result=f"Deploy COW from {depot['name']} ({best['tow_km']} km tow) to "
            f"({best['lat']}, {best['lng']}) @ {height:.0f} m — covers a {radius_km:.1f} km "
            f"radius, protecting {best['buildings_protected']} emergency building(s). "
            f"Coverage restored in ~{eta['total_min']:.0f} min "
            f"({eta['drive_min']:.0f} min tow at traffic ×{eta['traffic_factor']}, "
            f"{eta['setup_min']:.0f} min setup); {tail}",
            observation={
                "cow": cow,
                "coverage_radius_km": radius_km,
                "holes_in_range": best["holes_in_range"],
                "source_station": {"name": depot["name"], "lat": depot["lat"], "lng": depot["lng"]},
                "tow_km": best["tow_km"],
                "max_km": max_km,
                "buildings_protected": best["buildings_protected"],
                "candidate_count": len(candidates),
                "reachable_count": len(reachable),
                "alternatives": shortlist,
                "restoration": eta,
                "verified": verified,
                "feasible": True,
                "source": "Sionna RT coverage twin" if verified
                else "fire-station depots + dead-zone geometry (hole closure unverified)",
            },
            ui_actions=ui,
        )

    # ── Starlink backhaul (TLE set loaded once per run; ~7k satellites) ──────────
    _starlink_sats: Any = None
    _starlink_ts: Any = None
    _starlink_tried = False

    def _get_starlink(self):
        """Lazily load Starlink TLEs + a shared Skyfield timescale once per run. Returns
        (satellites, timescale), or (None, None) if skyfield/TLEs are unavailable."""
        if self._starlink_tried:
            return self._starlink_sats, self._starlink_ts
        self._starlink_tried = True
        try:
            from skyfield.api import load

            from . import tle
            ts = load.timescale()
            self._starlink_ts = ts
            self._starlink_sats = tle.load_starlink_tles(ts=ts)
        except Exception:
            self._starlink_sats = None
        return self._starlink_sats, self._starlink_ts

    def _check_starlink(self, args: dict[str, Any]) -> ToolResult:
        """Which Starlink satellite backhauls a COW at (lat, lng) RIGHT NOW — the COW has no
        fibre, so it uplinks via satellite. Computed with Skyfield over the freshest TLE set
        (live CelesTrak fetch → disk cache → bundled snapshot; see tle.py). Honest error when
        the constellation can't be loaded — never an invented satellite."""
        from datetime import UTC, datetime

        lat, lng = args.get("lat"), args.get("lng")
        if lat is None or lng is None:
            cow = self._last_cow or {}
            lat, lng = cow.get("lat"), cow.get("lng")
        if lat is None or lng is None:
            return ToolResult(
                result="check_starlink needs a COW position (lat/lng) or a prior deploy_cow.",
                observation={"error": "no lat/lng and no prior COW"},
            )
        lat, lng = float(lat), float(lng)
        when = datetime.now(UTC)

        sats, ts = self._get_starlink()
        if not sats:
            _warn_degraded("check_starlink", "skyfield/Starlink TLEs unavailable")
            return ToolResult(
                result="Cannot compute Starlink visibility — the TLE constellation could not "
                "be loaded (skyfield missing or no TLE source reachable).",
                observation={
                    "error": "no TLE constellation",
                    "cow_position": {"lat": lat, "lng": lng},
                    "source": "none",
                },
            )
        try:
            from .starlink import best_satellite
            view = best_satellite(lat, lng, when, tles=sats, ts=ts)
        except Exception as exc:
            _warn_degraded("check_starlink", f"visibility compute failed ({exc!r})")
            return ToolResult(
                result=f"Starlink visibility computation failed: {exc}",
                observation={
                    "error": "visibility compute failed",
                    "detail": repr(exc),
                    "cow_position": {"lat": lat, "lng": lng},
                    "source": "none",
                },
            )
        if view is None:
            return ToolResult(
                result="No Starlink satellite is above the 25° elevation mask at this "
                "location right now — the next pass is minutes away (Starlink revisit is "
                "near-continuous over London).",
                observation={
                    "satellite": None,
                    "cow_position": {"lat": lat, "lng": lng},
                    "checked_at_utc": when.isoformat(timespec="seconds"),
                    "source": "Skyfield (Starlink TLEs)",
                },
            )
        return ToolResult(
            result=f"COW backhaul: {view.name} at {view.elevation_deg:.0f}° elevation, "
            f"{view.slant_range_km:.0f} km slant range",
            observation={
                "satellite": view.name,
                "norad_id": view.norad_id,
                "elevation_deg": round(view.elevation_deg, 1),
                "azimuth_deg": round(view.azimuth_deg, 1),
                "slant_range_km": round(view.slant_range_km, 1),
                "altitude_km": round(view.altitude_km, 1),
                "cow_position": {"lat": lat, "lng": lng},
                "checked_at_utc": when.isoformat(timespec="seconds"),
                "source": "Skyfield (Starlink TLEs)",
            },
        )

    # ── locate (nearest emergency-service building) ──────────────────────────────
    # Central-London fallback reference when the operator gives no point and no COW is placed
    # (centre of the simulated square — Bankside/London Bridge).
    _DEFAULT_REF = (51.5045, -0.0900)

    def _find_nearest(self, args: dict[str, Any]) -> ToolResult:
        """Nearest hospital / police / fire building to a reference point, highlighted on the
        map. Reference = explicit lat/lng → last COW → central London. Data is the bundled
        London emergency CSVs (no GPU/twin needed)."""
        from .emergency import haversine_km, load_emergency_buildings

        kind = (args.get("kind") or "").strip().lower()
        if kind not in ("hospital", "police", "fire"):
            return ToolResult(
                result="find_nearest needs kind ∈ hospital|police|fire.",
                observation={"error": f"bad kind {kind!r}"},
            )
        lat, lng = args.get("lat"), args.get("lng")
        if lat is None or lng is None:
            ref = self._last_cow or {}
            lat = ref.get("lat", self._DEFAULT_REF[0])
            lng = ref.get("lng", self._DEFAULT_REF[1])
        lat, lng = float(lat), float(lng)

        pool = [b for b in load_emergency_buildings() if b["kind"] == kind]
        if not pool:
            _warn_degraded("find_nearest", f"no {kind} buildings loaded")
            return ToolResult(
                result=f"No {kind} buildings are loaded.",
                observation={"error": "no data", "kind": kind},
            )
        best = min(pool, key=lambda b: haversine_km(lat, lng, b["lat"], b["lng"]))
        km = haversine_km(lat, lng, best["lat"], best["lng"])

        marker = {
            "id": "nearest", "position": [best["lng"], best["lat"]], "kind": "building",
            "label": best["name"], "detail": f"{kind.title()} · {km:.1f} km",
        }
        ui = [{
            "op": "markers", "markers": [marker],
            "focus": {"center": [best["lng"], best["lat"]], "zoom": 15.5, "pitch": 45},
        }]
        return ToolResult(
            result=f"Nearest {kind}: {best['name']} ({km:.1f} km away) — highlighted on the map.",
            observation={
                "name": best["name"], "kind": kind, "distance_km": round(km, 2),
                "position": {"lat": best["lat"], "lng": best["lng"]},
                "source": "data/emergency",
            },
            ui_actions=ui,
        )

    # ── knowledge graph: locate a named place / scan surroundings / network overview ──
    # These read the spatial knowledge graph in places.py (the curated gazetteer the dashboard
    # map labels are drawn from, UNIONed with the emergency-service buildings) so the agent
    # resolves any name the operator can see and flies the camera to it. No GPU/twin needed.
    @staticmethod
    def _is_emergency_cat(category: str) -> bool:
        return category in ("police", "fire", "hospital")

    def _locate_place(self, args: dict[str, Any]) -> ToolResult:
        """Resolve a NAMED place from the knowledge graph and fly the camera to it — the
        headline 'point the camera' tool. Works for landmarks/areas/transport/etc. AND named
        emergency buildings; remembers it as the last reference for follow-up nearby queries."""
        from .places import category_zoom, in_coverage, resolve_place, suggest_places

        query = (args.get("query") or args.get("name") or args.get("place") or "").strip()
        if not query:
            return ToolResult(
                result="locate_place needs a place name (query).",
                observation={"error": "no query"},
            )
        cat = (args.get("category") or "").strip().lower()
        cats = (cat,) if cat else None
        node = resolve_place(query, categories=cats)
        if node is None:
            sugg = suggest_places(query)
            hint = f" Closest names: {', '.join(sugg)}." if sugg else ""
            return ToolResult(
                result=f"Couldn't find '{query}' in the knowledge graph.{hint}",
                observation={"error": "unresolved", "query": query, "suggestions": sugg},
            )
        lat, lng = float(node["lat"]), float(node["lng"])
        # Remember as the reference point so a follow-up nearby_places/find_nearest can default
        # to "around the place we just flew to" (mirrors deploy_cow → check_starlink chaining).
        ToolRegistry._last_cow = {"lat": lat, "lng": lng, "label": node["name"]}
        zoom = args.get("zoom")
        zoom = float(zoom) if zoom is not None else category_zoom(node["category"])
        is_em = self._is_emergency_cat(node["category"])
        marker = {
            "id": "located", "position": [lng, lat],
            "kind": "building" if is_em else "poi",
            "label": node["name"],
            "detail": node["description"] or node["category"].title(),
        }
        ui = [
            {"op": "clear"},
            {"op": "markers", "markers": [marker],
             "focus": {"center": [lng, lat], "zoom": zoom, "pitch": 45}},
        ]
        cov = in_coverage(lat, lng)
        cov_note = " (note: outside the simulated coverage area)" if cov is False else ""
        desc = (node["description"] or node["category"].title()).rstrip(".")
        return ToolResult(
            result=f"{node['name']} — {desc}. Flown to and highlighted on the map{cov_note}.",
            observation={
                "name": node["name"],
                "category": node["category"],
                "position": {"lat": round(lat, 6), "lng": round(lng, 6)},
                "match_score": node["match_score"],
                "in_coverage": cov,
                "source": "knowledge-graph",
            },
            ui_actions=ui,
        )

    def _nearby_places(self, args: dict[str, Any]) -> ToolResult:
        """Knowledge-graph neighbourhood around a named place or point: the nearest landmarks
        and emergency services, markers dropped and the camera framed on the cluster."""
        from .places import nearby_places as kg_nearby
        from .places import resolve_place, suggest_places

        query = (args.get("query") or args.get("near") or "").strip()
        center_name = None
        exclude_id = None
        if query:
            node = resolve_place(query)
            if node is None:
                sugg = suggest_places(query)
                hint = f" Closest names: {', '.join(sugg)}." if sugg else ""
                return ToolResult(
                    result=f"Couldn't find '{query}' to scan around.{hint}",
                    observation={"error": "unresolved", "query": query, "suggestions": sugg},
                )
            lat, lng = float(node["lat"]), float(node["lng"])
            center_name = node["name"]
            exclude_id = node["id"]
        else:
            lat, lng = args.get("lat"), args.get("lng")
            if lat is None or lng is None:
                ref = self._last_cow or {}
                lat = ref.get("lat", self._DEFAULT_REF[0])
                lng = ref.get("lng", self._DEFAULT_REF[1])
                center_name = ref.get("label") or ("the deployed COW" if self._last_cow
                                                   else "central London")
            lat, lng = float(lat), float(lng)

        radius = float(args.get("radius_km") or 1.5)
        raw_cats = args.get("categories") or args.get("kinds") or None
        cats = tuple(str(c).strip().lower() for c in raw_cats) if raw_cats else None
        found = kg_nearby(lat, lng, radius, categories=cats, limit=12, exclude_id=exclude_id)

        anchor = center_name or f"({lat:.4f}, {lng:.4f})"
        if not found:
            return ToolResult(
                result=f"Nothing in the knowledge graph within {radius:.1f} km of {anchor}.",
                observation={"center": {"lat": lat, "lng": lng}, "radius_km": radius,
                             "results": [], "source": "knowledge-graph"},
            )
        markers = [
            {"id": f"near-{i}", "position": [n["lng"], n["lat"]],
             "kind": "building" if self._is_emergency_cat(n["category"]) else "poi",
             "label": n["name"], "detail": f"{n['category'].title()} · {n['distance_km']:.1f} km"}
            for i, n in enumerate(found)
        ]
        # Frame the camera on the centre + everything found (a padded bbox over all points).
        lngs = [lng] + [n["lng"] for n in found]
        lats = [lat] + [n["lat"] for n in found]
        pad = 0.004
        bbox = [min(lngs) - pad, min(lats) - pad, max(lngs) + pad, max(lats) + pad]
        ui = [
            {"op": "clear"},
            {"op": "markers", "markers": markers,
             "focus": {"bbox": [round(x, 6) for x in bbox], "pitch": 35}},
        ]
        top = ", ".join(f"{n['name']} ({n['distance_km']:.1f} km)" for n in found[:4])
        return ToolResult(
            result=f"{len(found)} place(s) within {radius:.1f} km of {anchor}: {top}"
            + ("…" if len(found) > 4 else "") + " — highlighted on the map.",
            observation={
                "center": {"name": center_name, "lat": round(lat, 6), "lng": round(lng, 6)},
                "radius_km": radius,
                "results": [
                    {"name": n["name"], "category": n["category"],
                     "distance_km": n["distance_km"]}
                    for n in found
                ],
                "source": "knowledge-graph",
            },
            ui_actions=ui,
        )

    def _describe_network(self, args: dict[str, Any]) -> ToolResult:
        """Network overview from the pipeline summary the HUD KPI panels read, with the camera
        framed over the whole simulated area."""
        from .places import coverage_bounds, load_network_summary

        s = load_network_summary()
        if not s:
            return ToolResult(
                result="No coverage summary is available yet — run the Sionna RT pipeline first.",
                observation={"error": "no summary", "source": "none"},
            )
        sites = s.get("sites_total")
        served = s.get("served_pct")
        holes = s.get("low_coverage_polys")
        buildings = s.get("buildings")
        cells = s.get("simulated_cells")
        rays = s.get("ray_paths")
        perf = s.get("performance") or {}
        bits = []
        if sites is not None:
            bits.append(f"{sites:,} EE masts")
        if buildings is not None:
            bits.append(f"{buildings:,} buildings modelled")
        if served is not None:
            bits.append(f"{served:.1f}% served")
        if holes is not None:
            bits.append(f"{holes} coverage hole(s)")
        device = perf.get("device")
        summary_line = "Network: " + ", ".join(bits) + (f" · {device}" if device else "") + "."
        ui: list[dict[str, Any]] = []
        cb = coverage_bounds()
        if cb:
            ui = [{"op": "focus",
                   "focus": {"bbox": [cb["west"], cb["south"], cb["east"], cb["north"]],
                             "pitch": 30}}]
        return ToolResult(
            result=summary_line + (" Camera framed on the simulated area." if cb else ""),
            observation={
                "sites_total": sites, "served_pct": served, "coverage_holes": holes,
                "buildings": buildings, "simulated_cells": cells, "ray_paths": rays,
                "performance": perf or None, "coverage_bounds": cb,
                "source": "pipeline summary.json",
            },
            ui_actions=ui,
        )

    def _find_masts(self, args: dict[str, Any]) -> ToolResult:
        """Masts around a place/point (or one mast by id), framed on the map. Reads the same
        masts.geojson / new_masts.geojson the HUD draws its towers from — so the agent answers
        from exactly the operator's mast inventory. The masts are already drawn as 3D towers, so
        this drives the camera (no extra markers) and reports the counts/operators/heights."""
        from .places import load_masts, mast_by_id, nearby_masts, resolve_place

        if not load_masts():
            _warn_degraded("find_masts", "masts.geojson not present (pipeline output missing)")
            return ToolResult(
                result="No mast data is loaded yet — run the coverage pipeline first.",
                observation={"error": "no masts", "source": "none"},
            )

        # Single-mast lookup: fly straight to it.
        mid = (args.get("mast_id") or "").strip()
        if mid:
            m = mast_by_id(mid)
            if m is None:
                return ToolResult(
                    result=f"No mast with id '{mid}' in the network.",
                    observation={"error": "unknown mast", "mast_id": mid},
                )
            bands = ", ".join(m["bands"]) or "n/a"
            ht = f"{m['height_m']:.0f} m" if m["height_m"] is not None else "unknown height"
            tag = "proposed" if m["proposed"] else m["operator"]
            ui = [{"op": "focus",
                   "focus": {"center": [m["lng"], m["lat"]], "zoom": 16.5, "pitch": 50}}]
            return ToolResult(
                result=f"Mast {m['id']} ({tag}) — {ht}, band(s) {bands}. Framed on the map.",
                observation={"mast": {k: m[k] for k in
                                      ("id", "operator", "height_m", "power_dbm", "bands",
                                       "proposed")},
                             "position": {"lat": m["lat"], "lng": m["lng"]},
                             "source": "masts.geojson"},
                ui_actions=ui,
            )

        # Area query: resolve a centre, count the masts around it.
        query = (args.get("query") or args.get("near") or "").strip()
        center_name = None
        if query:
            node = resolve_place(query)
            if node is None:
                return ToolResult(
                    result=f"Couldn't find '{query}' to scan for masts.",
                    observation={"error": "unresolved", "query": query},
                )
            lat, lng, center_name = float(node["lat"]), float(node["lng"]), node["name"]
        else:
            lat, lng = args.get("lat"), args.get("lng")
            if lat is None or lng is None:
                ref = self._last_cow or {}
                lat = ref.get("lat", self._DEFAULT_REF[0])
                lng = ref.get("lng", self._DEFAULT_REF[1])
                center_name = ref.get("label") or "central London"
            lat, lng = float(lat), float(lng)

        radius = float(args.get("radius_km") or 0.8)
        operator = args.get("operator")
        masts = nearby_masts(lat, lng, radius, operator=operator)
        anchor = center_name or f"({lat:.4f}, {lng:.4f})"
        if not masts:
            opnote = f" {operator}" if operator else ""
            return ToolResult(
                result=f"No{opnote} masts within {radius:.1f} km of {anchor}.",
                observation={"center": {"lat": lat, "lng": lng}, "radius_km": radius,
                             "count": 0, "masts": [], "source": "masts.geojson"},
            )
        ops: dict[str, int] = {}
        for m in masts:
            ops[m["operator"]] = ops.get(m["operator"], 0) + 1
        heights = [m["height_m"] for m in masts if m["height_m"] is not None]
        tallest = max(heights) if heights else None
        # Frame the cluster (masts already render as towers — just move the camera).
        lngs = [lng] + [m["lng"] for m in masts]
        lats = [lat] + [m["lat"] for m in masts]
        pad = 0.0025
        bbox = [min(lngs) - pad, min(lats) - pad, max(lngs) + pad, max(lats) + pad]
        ui = [{"op": "focus", "focus": {"bbox": [round(x, 6) for x in bbox], "pitch": 40}}]
        op_bits = ", ".join(f"{n} {o}" for o, n in sorted(ops.items(), key=lambda kv: -kv[1]))
        tall_bit = f", tallest {tallest:.0f} m" if tallest is not None else ""
        return ToolResult(
            result=f"{len(masts)} mast(s) within {radius:.1f} km of {anchor} "
            f"({op_bits}{tall_bit}) — framed on the map.",
            observation={
                "center": {"name": center_name, "lat": round(lat, 6), "lng": round(lng, 6)},
                "radius_km": radius,
                "count": len(masts),
                "operators": ops,
                "tallest_m": tallest,
                "masts": [
                    {"id": m["id"], "operator": m["operator"], "height_m": m["height_m"],
                     "bands": list(m["bands"]), "distance_m": round(m["distance_km"] * 1000)}
                    for m in masts[:8]
                ],
                "source": "masts.geojson",
            },
            ui_actions=ui,
        )

    def _clear_proposals(self, args: dict[str, Any]) -> ToolResult:
        """Wipe the cuOpt plan: the twin restores its baseline artifacts and strips the
        proposed masts' rays from the master ray file; the HUD re-fetches and the gold
        towers disappear. Honest error when the twin is unreachable."""
        import httpx

        twin = self._twin_url()
        if not twin:
            _warn_degraded("clear_proposals", "TWIN_URL not set")
            return ToolResult(
                result="Cannot clear the proposals — the coverage twin is unreachable "
                "(it owns the plan artifacts). Start it with python -m src.serve.",
                observation={"error": "no coverage backend", "source": "none"},
            )
        try:
            with httpx.Client(base_url=twin, timeout=120.0) as client:
                r = client.post("/api/clear_proposals")
                r.raise_for_status()
                summary = r.json()
        except Exception as exc:
            _warn_degraded("clear_proposals", f"twin /api/clear_proposals failed ({exc!r})")
            return ToolResult(
                result=f"Clearing the proposals failed: {exc}",
                observation={"error": "clear failed", "detail": repr(exc), "source": "none"},
            )
        restored = summary.get("restored_state") or {}
        served = restored.get("served_pct")
        tail = f" Baseline coverage restored ({served}% served)." if served is not None else ""
        return ToolResult(
            result=f"All proposed masts and their rays removed.{tail}",
            observation={
                "cleared": True,
                "restored_state": restored.get("label"),
                "served_pct": served,
                "source": "coverage twin (baseline restore)",
            },
            ui_actions=[{"op": "clear"}],
        )
