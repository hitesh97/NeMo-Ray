"""Emergency-service buildings, police-station COW depots, and the geometry that links a
coverage outage to the buildings it knocks out.

This is the agent-side half of the resilience tools (`simulate_outage`, `deploy_cow`):

  • which **emergency-service buildings** (police / fire / hospitals) fall inside the dead
    zones an outage opens — the "who loses service" answer; and
  • where a **Cell-on-Wheels** can go: we assume one COW is garaged at every **fire
    station** and it can be driven up to 3 km, so a dead zone is COW-coverable iff a fire
    station sits within that range.

Pure stdlib + pyproj only (no rasterio/Sionna) so it runs in the lightweight agent venv.
Data are the London CSVs shipped in `data/emergency/`:
    data/emergency/fire-stations-london.csv      (EPSG:27700 easting,northing — LFB assets)
    data/emergency/police-stations-london.csv    (WGS84 lng,lat — MOPAC closures)
    data/emergency/hospitals-england.csv         (WGS84 lat,lng — NHS/OSM, filtered to London)
"""

from __future__ import annotations

import csv
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

# Greater London — matches nemoray/lib/data/emergencyServices.ts LONDON_BBOX, used to clip
# the England-wide hospital list down to the simulated region.
LONDON_BBOX = {"lat_min": 51.28, "lat_max": 51.70, "lng_min": -0.52, "lng_max": 0.34}

# COW range assumption: a Cell-on-Wheels garaged at a fire station can be towed this far.
COW_MAX_KM = 3.0
# Once parked, a COW redistributes signal to roughly this radius (its backhaul is Starlink,
# but the ground cell it provides only reaches so far). Distinct from the tow limit above:
# COW_MAX_KM constrains *where it can go*, COW_COVERAGE_KM constrains *what it then serves*.
COW_COVERAGE_KM = 2.0
# A COW mast is short — used as the antenna height for its ray-tracing (todo: 20 m).
COW_HEIGHT_M = 20.0


def _repo_root() -> Path:
    """Repo root (holds data/emergency). Overridable with NEMORAY_ROOT for odd layouts."""
    env = os.environ.get("NEMORAY_ROOT")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / "data" / "emergency").is_dir():
            return p
    # agent/nemoray_modelling/emergency.py -> repo root is two parents up.
    return here.parents[2]


def _data_dir() -> Path:
    return _repo_root() / "data" / "emergency"


def _to_float(s: Any) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _in_london(lat: float, lng: float) -> bool:
    b = LONDON_BBOX
    return b["lat_min"] <= lat <= b["lat_max"] and b["lng_min"] <= lng <= b["lng_max"]


# ── data loaders (cached: CSVs are static for a process) ────────────────────────
@lru_cache(maxsize=1)
def load_fire_stations() -> tuple[dict[str, Any], ...]:
    """Fire stations = COW depots (one COW each, our assumption — user-confirmed).

    London Fire Brigade asset locations (EPSG:27700 easting,northing → WGS84). This is the
    official LFB "holdings" list (~116 rows: stations + a few workshops/annexes), which is
    fine for depot/tow-range purposes.
    """
    path = _data_dir() / "fire-stations-london.csv"
    out: list[dict[str, Any]] = []
    if not path.exists():
        return tuple(out)
    from pyproj import Transformer
    en_to_lnglat = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            e, n = _to_float(row.get("Easting")), _to_float(row.get("Northing"))
            if e is None or n is None:
                continue
            lng, lat = en_to_lnglat.transform(e, n)
            raw = row.get("Holding_Name") or row.get("Borough") or "Fire Station"
            name = raw.strip().title()
            out.append({
                "name": f"{name} Fire Station",
                "lat": float(lat),
                "lng": float(lng),
                "operational": True,
            })
    return tuple(out)


@lru_cache(maxsize=1)
def load_police_stations() -> tuple[dict[str, Any], ...]:
    """Police stations (MOPAC). WGS84 already. Used for building-impact (not COW depots)."""
    path = _data_dir() / "police-stations-london.csv"
    out: list[dict[str, Any]] = []
    if not path.exists():
        return tuple(out)
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            lng, lat = _to_float(row.get("longitude")), _to_float(row.get("latitude"))
            if lat is None or lng is None:
                continue
            proposed = (row.get("proposed") or "").strip().upper()
            out.append({
                "name": (row.get("name") or "Police Station").strip().title(),
                "lat": lat,
                "lng": lng,
                # Whether it's still an operational station (a closed site has no COW).
                "operational": proposed != "CLOSED",
            })
    return tuple(out)


@lru_cache(maxsize=1)
def load_emergency_buildings() -> tuple[dict[str, Any], ...]:
    """All emergency-service buildings in London: police, fire, hospitals → WGS84 points."""
    out: list[dict[str, Any]] = []

    # Police (WGS84 lng,lat).
    for p in load_police_stations():
        out.append({"name": p["name"], "kind": "police", "lat": p["lat"], "lng": p["lng"]})

    # Fire (EPSG:27700, transformed in load_fire_stations()).
    for fstn in load_fire_stations():
        out.append({"name": fstn["name"], "kind": "fire",
                    "lat": fstn["lat"], "lng": fstn["lng"]})

    # Hospitals (WGS84 lat,lng), clipped to London.
    hosp = _data_dir() / "hospitals-england.csv"
    if hosp.exists():
        with open(hosp, newline="") as f:
            for row in csv.DictReader(f):
                lat, lng = _to_float(row.get("Latitude")), _to_float(row.get("Longitude"))
                if lat is None or lng is None or not _in_london(lat, lng):
                    continue
                out.append({"name": (row.get("Name") or "Hospital").strip(),
                            "kind": "hospital", "lat": lat, "lng": lng})

    return tuple(out)


# ── geometry (no shapely: ray-casting + haversine) ──────────────────────────────
def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _ring_contains(lng: float, lat: float, ring: list[list[float]]) -> bool:
    """Even-odd ray-casting point-in-polygon. Ring is [[lng,lat], ...] (GeoJSON order)."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _polys_of(feature: dict[str, Any]) -> list[list[list[float]]]:
    """Outer rings of a (Multi)Polygon feature, ignoring inner holes (conservative)."""
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates") or []
    t = geom.get("type")
    if t == "Polygon":
        return [coords[0]] if coords else []
    if t == "MultiPolygon":
        return [poly[0] for poly in coords if poly]
    return []


def feature_contains(lng: float, lat: float, feature: dict[str, Any]) -> bool:
    return any(_ring_contains(lng, lat, ring) for ring in _polys_of(feature))


def ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    """(lng, lat) average of a ring's vertices — good enough for a small dead-zone cell."""
    n = max(len(ring), 1)
    return sum(c[0] for c in ring) / n, sum(c[1] for c in ring) / n


def feature_centroid(feature: dict[str, Any]) -> tuple[float, float] | None:
    polys = _polys_of(feature)
    if not polys:
        return None
    return ring_centroid(polys[0])


# Dead zones are 25 m radio cells, smaller than a building footprint, so an exact
# point-in-cell test almost never fires even for a building sitting in a coverage hole.
# Standard coverage practice is to snap demand points to the dead-cell grid: a building
# counts as in a dead zone if a dead cell is within this radius of it.
DEAD_ZONE_BUFFER_M = 100.0


def buildings_in_zones(
    features: list[dict[str, Any]],
    buildings: list[dict[str, Any]] | None = None,
    buffer_m: float = DEAD_ZONE_BUFFER_M,
) -> list[dict[str, Any]]:
    """Emergency-service buildings that fall inside (or within `buffer_m` of) a dead zone →
    lost or degraded service. Each hit carries `distance_m` (0 = strictly inside a hole)."""
    buildings = list(buildings if buildings is not None else load_emergency_buildings())
    centroids = [feature_centroid(f) for f in features]
    hit: list[dict[str, Any]] = []
    for b in buildings:
        chosen: tuple[int, dict[str, Any]] | None = None
        chosen_d: float | None = None
        for i, feat in enumerate(features):
            if feature_contains(b["lng"], b["lat"], feat):
                chosen, chosen_d = (i, feat), 0.0
                break
            c = centroids[i]
            if c is None:
                continue
            d = haversine_km(b["lat"], b["lng"], c[1], c[0]) * 1000.0
            if d <= buffer_m and (chosen_d is None or d < chosen_d):
                chosen, chosen_d = (i, feat), d
        if chosen is not None:
            i, feat = chosen
            zid = (feat.get("properties") or {}).get("id") or f"dz-{i:02d}"
            hit.append({**b, "dead_zone_id": zid, "distance_m": round(chosen_d or 0.0)})
    return hit


def nearest_depot(lat: float, lng: float, depots: list[dict[str, Any]] | None = None
                  ) -> tuple[dict[str, Any] | None, float]:
    """Closest fire-station COW depot to a point, with great-circle distance (km)."""
    depots = list(depots if depots is not None else load_fire_stations())
    best, best_km = None, float("inf")
    for d in depots:
        km = haversine_km(lat, lng, d["lat"], d["lng"])
        if km < best_km:
            best, best_km = d, km
    return best, best_km


def buildings_within_radius(
    lat: float,
    lng: float,
    radius_km: float = COW_COVERAGE_KM,
    buildings: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Emergency-service buildings a COW parked at (lat, lng) actually reaches — i.e. within
    its `radius_km` redistribution disc. Each hit carries `distance_m` from the COW so the
    agent can rank candidates by who they protect. This is the coverage-side counterpart to
    `nearest_depot`'s tow-side check."""
    buildings = list(buildings if buildings is not None else load_emergency_buildings())
    hit: list[dict[str, Any]] = []
    for b in buildings:
        km = haversine_km(lat, lng, b["lat"], b["lng"])
        if km <= radius_km:
            hit.append({**b, "distance_m": round(km * 1000.0)})
    return hit
