"""Spatial knowledge graph of named London places for the Nemotron agent.

This is the gazetteer half of the agent's geographic knowledge — it lets the agent turn a
*name* the operator says ("Tower Bridge", "Guy's Hospital", "Canary Wharf", "the nearest
fire station to the Shard") into coordinates and point the dashboard camera at it. The two
new tools in tools.py (`locate_place`, `nearby_places`) are thin wrappers over the resolver
and neighbourhood query here; `describe_network` reads the same coverage summary the HUD's
KPI panels show.

Sources, **knowledge-graph first, CSVs as fallback** (per the product decision):
  • PRIMARY — the curated place gazetteer the dashboard map labels are also drawn from:
    `nemoray/public/geo/landmarks.json` (the single source of truth; DeckScene fetches the
    same file). Areas, landmarks, transport hubs, stadiums, parks, museums, government.
  • The emergency-service *buildings* (police / fire / hospitals) are merged in at runtime
    from `emergency.py` (which now reads the HUD's CSVs first) so every named station/hospital
    the operator sees is also resolvable here — without duplicating them into the gazetteer.
  • Coverage extent + network totals come from the pipeline's `summary.json` (what the HUD
    telemetry panels read), so the agent knows the simulated area and can answer "how big is
    the network / what's the coverage".

The graph nodes are the union (gazetteer places + emergency buildings); the edges are
spatial/categorical and computed on demand (nearest, within-radius, same-category) rather
than precomputed, so they never go stale. Pure stdlib (json/math/difflib) — runs in the
lightweight agent venv, no GPU/twin.
"""

from __future__ import annotations

import json
import os
import re
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Any

from .emergency import LONDON_BBOX, _repo_root, haversine_km, load_emergency_buildings

# Categories carried by gazetteer nodes (emergency buildings use police|fire|hospital).
PLACE_CATEGORIES = (
    "area", "landmark", "attraction", "transport", "stadium", "park", "museum", "government",
)
EMERGENCY_CATEGORIES = ("police", "fire", "hospital")

# How tightly to frame the camera when locating a place, by category. Areas/parks are big →
# pull back; a single building/landmark → zoom right in. (HUD MapFocus.zoom semantics.)
_CATEGORY_ZOOM: dict[str, float] = {
    "area": 13.0,
    "park": 13.5,
    "stadium": 14.5,
    "transport": 15.0,
    "museum": 15.0,
    "government": 15.0,
    "attraction": 15.0,
    "landmark": 15.5,
    "police": 15.5,
    "fire": 15.5,
    "hospital": 15.5,
}
DEFAULT_ZOOM = 15.0


# ── gazetteer loading (cached: the JSON is static for a process) ─────────────────
def _gazetteer_path() -> Path | None:
    """Locate the canonical place gazetteer. Primary: the file the HUD map labels are drawn
    from (`nemoray/public/geo/landmarks.json`) so the agent's knowledge and the dashboard
    never drift. Overridable with NEMORAY_LANDMARKS for odd layouts; a legacy repo-root copy
    is accepted as a fallback."""
    env = os.environ.get("NEMORAY_LANDMARKS")
    if env and Path(env).is_file():
        return Path(env)
    root = _repo_root()
    for rel in (
        "nemoray/public/geo/landmarks.json",
        "data/landmarks/landmarks-london.json",
    ):
        p = root / rel
        if p.is_file():
            return p
    return None


@lru_cache(maxsize=1)
def load_landmarks() -> tuple[dict[str, Any], ...]:
    """Curated named places (areas / landmarks / transport / stadiums / parks / museums /
    government) from the canonical gazetteer, clipped to the London bbox. Each node:
    {id, name, category, lat, lng, aliases: tuple, description}."""
    path = _gazetteer_path()
    if path is None:
        return tuple()
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return tuple()
    out: list[dict[str, Any]] = []
    for rec in raw.get("places", []):
        try:
            lat, lng = float(rec["lat"]), float(rec["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        b = LONDON_BBOX
        if not (b["lat_min"] <= lat <= b["lat_max"] and b["lng_min"] <= lng <= b["lng_max"]):
            continue
        out.append({
            "id": str(rec.get("id") or _slug(rec.get("name", ""))),
            "name": str(rec.get("name", "")).strip(),
            "category": str(rec.get("category", "landmark")),
            "lat": lat,
            "lng": lng,
            "aliases": tuple(str(a).strip() for a in (rec.get("aliases") or []) if str(a).strip()),
            "description": str(rec.get("description", "")).strip(),
        })
    return tuple(out)


@lru_cache(maxsize=1)
def load_places() -> tuple[dict[str, Any], ...]:
    """The full knowledge-graph node set: curated gazetteer places (primary) UNIONed with the
    emergency-service buildings (police / fire / hospital) so every name the operator can see —
    a landmark label OR a station/hospital — resolves to coordinates. Emergency buildings get
    category ∈ police|fire|hospital and a synthetic id; they carry no aliases."""
    nodes: list[dict[str, Any]] = list(load_landmarks())
    seen_ids = {n["id"] for n in nodes}
    for b in load_emergency_buildings():
        bid = _slug(f"{b['kind']}-{b['name']}")
        if bid in seen_ids:
            continue
        seen_ids.add(bid)
        nodes.append({
            "id": bid,
            "name": b["name"],
            "category": b["kind"],  # police | fire | hospital
            "lat": float(b["lat"]),
            "lng": float(b["lng"]),
            "aliases": (),
            "description": _emergency_descriptor(b["kind"]).capitalize() + ".",
            "emergency": True,
        })
    return tuple(nodes)


def _emergency_descriptor(kind: str) -> str:
    return {
        "police": "police station",
        "fire": "fire station",
        "hospital": "hospital",
    }.get(kind, "emergency service")


# ── name resolution (fuzzy gazetteer lookup) ────────────────────────────────────
def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _norm(s: str) -> str:
    """Lowercase, drop punctuation, collapse whitespace, and strip noise words so 'the Shard',
    'shard.' and 'SHARD' all compare equal."""
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    toks = [t for t in s.split() if t not in _STOP]
    return " ".join(toks)


# Noise tokens that shouldn't drive a match (so "the o2" ~ "o2", "guys hospital" ~ "guys").
# NB: "london" is deliberately NOT here — it's a distinguishing token in many real names
# ("Royal London Hospital", "London Bridge"), so stripping it collapses distinct places.
_STOP = {"the", "a", "an", "of", "and", "st", "station"}


def _match_score(query: str, name: str) -> float:
    """0..1 similarity of a free-text query to one candidate name/alias. Rewards exact and
    prefix/containment hits, with a fuzzy ratio as the floor so typos still resolve."""
    q, n = _norm(query), _norm(name)
    if not q or not n:
        return 0.0
    if q == n:
        return 1.0
    qt, nt = set(q.split()), set(n.split())
    # All query tokens present in the candidate (e.g. "tower bridge" ⊂ "tower bridge"): strong.
    if qt and qt <= nt:
        return 0.92 if len(qt) == len(nt) else 0.86
    if n.startswith(q) or q.startswith(n):
        return 0.8
    if q in n or n in q:
        return 0.72
    overlap = len(qt & nt) / max(len(qt | nt), 1)
    return max(SequenceMatcher(None, q, n).ratio(), overlap)


def resolve_place(
    query: str,
    *,
    categories: tuple[str, ...] | None = None,
    threshold: float = 0.55,
) -> dict[str, Any] | None:
    """Best knowledge-graph node for a free-text place name, or None if nothing clears
    `threshold`. Scores every node's name + aliases; optionally restrict to `categories`
    (e.g. only ('hospital',)). The returned dict is the node plus `match_score`."""
    if not query or not query.strip():
        return None
    pool = load_places()
    if categories:
        cats = set(categories)
        pool = tuple(p for p in pool if p["category"] in cats)
    best: dict[str, Any] | None = None
    best_score = 0.0
    for node in pool:
        score = _match_score(query, node["name"])
        for alias in node["aliases"]:
            score = max(score, _match_score(query, alias) * 0.98)
        if score > best_score:
            best, best_score = node, score
    if best is None or best_score < threshold:
        return None
    return {**best, "match_score": round(best_score, 3)}


def suggest_places(query: str, limit: int = 3) -> list[str]:
    """A few closest names for a query that didn't resolve — so a tool can say 'did you mean…'."""
    scored = sorted(
        ((_match_score(query, p["name"]), p["name"]) for p in load_places()),
        reverse=True,
    )
    return [name for _, name in scored[:limit]]


# ── neighbourhood queries (spatial edges, computed on demand) ────────────────────
def nearby_places(
    lat: float,
    lng: float,
    radius_km: float = 1.5,
    *,
    categories: tuple[str, ...] | None = None,
    limit: int = 12,
    exclude_id: str | None = None,
) -> list[dict[str, Any]]:
    """Knowledge-graph nodes within `radius_km` of a point, nearest first. Optionally filter to
    `categories` (e.g. emergency-only). Each result carries `distance_km`."""
    cats = set(categories) if categories else None
    out: list[dict[str, Any]] = []
    for node in load_places():
        if exclude_id and node["id"] == exclude_id:
            continue
        if cats and node["category"] not in cats:
            continue
        km = haversine_km(lat, lng, node["lat"], node["lng"])
        if km <= radius_km:
            out.append({**node, "distance_km": round(km, 3)})
    out.sort(key=lambda n: n["distance_km"])
    return out[:limit]


def category_zoom(category: str) -> float:
    return _CATEGORY_ZOOM.get(category, DEFAULT_ZOOM)


# ── coverage extent + network summary (mirrors the HUD telemetry panels) ─────────
@lru_cache(maxsize=1)
def _summary_path() -> Path | None:
    root = _repo_root()
    for rel in ("nemoray/public/raytracing/summary.json", "out/summary.json"):
        p = root / rel
        if p.is_file():
            return p
    return None


@lru_cache(maxsize=1)
def load_network_summary() -> dict[str, Any]:
    """The pipeline run summary the HUD's KPI panels read (sites_total, served_pct, dead-zone
    count, buildings, coverage_bounds, GPU/RT perf). Empty dict if the artifact isn't present
    (e.g. coverage hasn't been generated)."""
    path = _summary_path()
    if path is None:
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def coverage_bounds() -> dict[str, float] | None:
    """[west, south, east, north] of the actually-simulated area (from summary.json), or None.
    Smaller than the London bbox — central/east London — so the agent can tell a caller when a
    place sits outside the modelled scene."""
    cb = load_network_summary().get("coverage_bounds")
    if not cb:
        return None
    try:
        return {k: float(cb[k]) for k in ("west", "south", "east", "north")}
    except (KeyError, TypeError, ValueError):
        return None


def in_coverage(lat: float, lng: float) -> bool | None:
    """True/False if (lat,lng) is inside the simulated coverage extent, or None if unknown
    (no summary). Lets a tool flag 'outside the simulated area' when flying somewhere far."""
    cb = coverage_bounds()
    if cb is None:
        return None
    return cb["west"] <= lng <= cb["east"] and cb["south"] <= lat <= cb["north"]


# ── masts / network elements (the dashboard's tower layer) ───────────────────────
# The HUD draws the EE/Orange masts (and cuOpt-proposed sites) as 3D towers from these
# GeoJSON artifacts; this gives the agent the SAME mast inventory so it can answer "how many
# masts are around X / tell me about mast Y" and frame the camera on them. Best-effort: the
# artifacts are gitignored pipeline output, so these return () when absent.
def _raytracing_file(name: str) -> Path | None:
    root = _repo_root()
    for rel in (f"nemoray/public/raytracing/{name}", f"out/{name}"):
        p = root / rel
        if p.is_file():
            return p
    return None


def _load_mast_file(name: str, proposed: bool) -> list[dict[str, Any]]:
    path = _raytracing_file(name)
    if path is None:
        return []
    try:
        feats = json.loads(path.read_text()).get("features", [])
    except (OSError, ValueError):
        return []
    out: list[dict[str, Any]] = []
    for f in feats:
        try:
            lng, lat = f["geometry"]["coordinates"][:2]
        except (KeyError, TypeError, ValueError):
            continue
        p = f.get("properties", {}) or {}
        bands = p.get("bands") or []
        out.append({
            "id": str(p.get("id", "")),
            "operator": str(p.get("operator") or ("proposed" if proposed else "EE")),
            "lat": float(lat),
            "lng": float(lng),
            "height_m": p.get("height_m"),
            "power_dbm": p.get("power_dbm"),
            "bands": tuple(str(b) for b in bands) if isinstance(bands, list) else (),
            # cuOpt-proposed masts carry how many dead-zone cells they close.
            "covers_holes": p.get("covers_holes"),
            "proposed": proposed,
        })
    return out


@lru_cache(maxsize=1)
def load_masts() -> tuple[dict[str, Any], ...]:
    """Every mast the dashboard shows: the existing EE/Orange sites (`masts.geojson`) plus the
    cuOpt-proposed new masts (`new_masts.geojson`), each {id, operator, lat, lng, height_m,
    power_dbm, bands, proposed}. Empty when the (gitignored) artifacts aren't present."""
    return tuple(_load_mast_file("masts.geojson", False)
                 + _load_mast_file("new_masts.geojson", True))


def mast_by_id(mast_id: str) -> dict[str, Any] | None:
    """Look up one mast by its exact id (case-insensitive), or None."""
    if not mast_id:
        return None
    key = mast_id.strip().lower()
    for m in load_masts():
        if m["id"].lower() == key:
            return m
    return None


# The simulated network is EE, whose masts the Sitefinder proxy lists under its two
# constituent legacy brands — so an "EE" operator filter must match these.
_EE_BRANDS = ("ee", "orange", "t-mobile", "tmobile", "t mobile")


def _operator_matches(mast_op: str, query_op: str) -> bool:
    mo, qo = mast_op.lower(), query_op.lower()
    if qo in ("ee", "bt", "ee/bt"):  # EE network = Orange + T-Mobile (its constituents)
        return any(b in mo for b in _EE_BRANDS)
    return qo in mo


def nearby_masts(
    lat: float,
    lng: float,
    radius_km: float = 0.8,
    *,
    operator: str | None = None,
    limit: int = 60,
) -> list[dict[str, Any]]:
    """Masts within `radius_km` of a point, nearest first, each carrying `distance_km`.
    Optionally filter by operator (case-insensitive; 'EE' matches its Orange/T-Mobile masts)."""
    op = operator.strip() if operator else None
    out: list[dict[str, Any]] = []
    for m in load_masts():
        if op and not _operator_matches(m["operator"], op):
            continue
        km = haversine_km(lat, lng, m["lat"], m["lng"])
        if km <= radius_km:
            out.append({**m, "distance_km": round(km, 3)})
    out.sort(key=lambda m: m["distance_km"])
    return out[:limit]


@lru_cache(maxsize=1)
def load_proposed_masts() -> tuple[dict[str, Any], ...]:
    """The cuOpt-proposed new masts (the `proposed` subset of the mast inventory) — each with
    its `covers_holes`. This is the REAL optimiser output the HUD draws as gold towers; the
    agent's offline cuOpt fixture reads it so it stops inventing a single Westminster site."""
    return tuple(m for m in load_masts() if m.get("proposed"))


# ── real coverage holes (dead zones) + optimiser summary (the HUD heatmap's data) ─────
def _outer_ring(feature: dict[str, Any]) -> list[list[float]] | None:
    g = feature.get("geometry") or {}
    t, c = g.get("type"), g.get("coordinates") or []
    if t == "Polygon":
        return c[0] if c else None
    if t == "MultiPolygon":
        return c[0][0] if c and c[0] else None
    return None


@lru_cache(maxsize=1)
def load_hotspots() -> tuple[dict[str, Any], ...]:
    """The REAL coverage dead zones the pipeline found (`hotspots.geojson` — exactly the holes
    the dashboard heatmap shows), each {id, centroid:(lng,lat), bbox, severity}. Empty when the
    (gitignored) artifact isn't present. The agent's offline coverage fixture uses these so it
    reflects the real multi-zone map instead of two hardcoded Westminster boxes."""
    path = _raytracing_file("hotspots.geojson")
    if path is None:
        return tuple()
    try:
        feats = json.loads(path.read_text()).get("features", [])
    except (OSError, ValueError):
        return tuple()
    out: list[dict[str, Any]] = []
    for i, f in enumerate(feats):
        ring = _outer_ring(f)
        if not ring:
            continue
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        props = f.get("properties", {}) or {}
        out.append({
            "id": props.get("id") or f"dz-{i:02d}",
            "centroid": (sum(xs) / len(xs), sum(ys) / len(ys)),
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
            "severity": props.get("severity", "major"),
        })
    return tuple(out)


@lru_cache(maxsize=1)
def load_optimization_summary() -> dict[str, Any]:
    """The cuOpt run summary (`optimization.json`): existing_masts, coverage_holes, new_masts,
    solver, status, solve_time_s. Empty dict when absent."""
    path = _raytracing_file("optimization.json")
    if path is None:
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
