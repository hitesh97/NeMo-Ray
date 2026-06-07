"""Twin-side emergency-service buildings → GeoJSON for the viewer.

Reads the public London datasets shipped in `data/emergency/` and writes
`out/emergency.geojson` (WGS84 points tagged `kind` ∈ police/fire/hospital), which the
deck.gl viewer colours and overlays. The agent has its own stdlib copy of this logic
(`agent/nemoray_modelling/emergency.py`) for tool reasoning; both read the same CSVs so
the map and the agent agree on "which buildings lose service".

Sources:
  fire-stations-london.csv    LFB asset locations (EPSG:27700 easting,northing)
  police-stations-london.csv  MOPAC stations (WGS84 lng,lat; lone-\\r line endings)
  hospitals-england.csv       NHS/OSM (WGS84 lat,lng; clipped to the London bbox)
"""
from __future__ import annotations

import csv
import json
import os

from .geo import en_to_lnglat, lnglat_to_en


def _to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _rows(path):
    # newline="" lets csv handle \r, \n and \r\n (the police CSV uses lone \r).
    with open(path, newline="") as f:
        yield from csv.DictReader(f)


def load_emergency_features(cfg) -> list[dict]:
    """All London emergency-service buildings as GeoJSON point features."""
    bbox = cfg["bbox"]
    d = os.path.join(cfg["paths"]["data_dir"], "emergency")
    feats: list[dict] = []

    def add(name, kind, lng, lat):
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]},
            "properties": {"name": name, "kind": kind},
        })

    # Fire (EPSG:27700 → WGS84). These double as the COW depots.
    fire = os.path.join(d, "fire-stations-london.csv")
    if os.path.exists(fire):
        for row in _rows(fire):
            e, n = _to_float(row.get("Easting")), _to_float(row.get("Northing"))
            if e is None or n is None:
                continue
            lng, lat = en_to_lnglat(e, n)
            raw = (row.get("Holding_Name") or row.get("Borough") or "Fire Station").strip().title()
            add(f"{raw} Fire Station", "fire", lng, lat)

    # Police (WGS84 lng,lat).
    police = os.path.join(d, "police-stations-london.csv")
    if os.path.exists(police):
        for row in _rows(police):
            lng, lat = _to_float(row.get("longitude")), _to_float(row.get("latitude"))
            if lat is None or lng is None:
                continue
            add((row.get("name") or "Police Station").strip().title(), "police", lng, lat)

    # Hospitals (WGS84 lat,lng), clipped to the configured bbox.
    hosp = os.path.join(d, "hospitals-england.csv")
    if os.path.exists(hosp):
        for row in _rows(hosp):
            lat, lng = _to_float(row.get("Latitude")), _to_float(row.get("Longitude"))
            if lat is None or lng is None:
                continue
            if not (bbox["lat_min"] <= lat <= bbox["lat_max"]
                    and bbox["lng_min"] <= lng <= bbox["lng_max"]):
                continue
            add((row.get("Name") or "Hospital").strip(), "hospital", lng, lat)

    return feats


def export_emergency(cfg) -> int:
    """Write out/emergency.geojson; return the feature count."""
    feats = load_emergency_features(cfg)
    out = cfg["paths"]["out_dir"]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "emergency.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    return len(feats)


def _coverage_bounds(cfg):
    """The simulated area's WGS84 bounds (from the last pipeline export), or None."""
    try:
        with open(os.path.join(cfg["paths"]["out_dir"], "coverage_bounds.json")) as f:
            b = json.load(f)
        return b["west"], b["south"], b["east"], b["north"]
    except (OSError, KeyError, ValueError):
        return None


def export_emergency_buildings(cfg) -> int:
    """Match each emergency-service point to the OSM building footprint it sits in and write
    those WHOLE footprints (out/emergency_buildings.geojson, WGS84, tagged kind/name/height)
    so the viewer can colour the entire building. Clipped to the simulated coverage area so
    we only tag buildings the viewer actually renders."""
    import geopandas as gpd
    import shapely
    from shapely.geometry import mapping

    from .osm import load_buildings

    out = cfg["paths"]["out_dir"]
    feats = load_emergency_features(cfg)
    bnds = _coverage_bounds(cfg)
    if bnds:
        w, s, e, n = bnds
        pad = 0.01
        feats = [f for f in feats
                 if w - pad <= f["geometry"]["coordinates"][0] <= e + pad
                 and s - pad <= f["geometry"]["coordinates"][1] <= n + pad]
    if not feats:
        with open(os.path.join(out, "emergency_buildings.geojson"), "w") as f:
            json.dump({"type": "FeatureCollection", "features": []}, f)
        return 0

    buildings = load_buildings(cfg)                       # EPSG:27700
    sindex = buildings.sindex
    geoms = buildings.geometry.values
    heights = buildings["height"].values if "height" in buildings else None

    # kind priority when a footprint matches more than one point (hospital wins, then fire).
    rank = {"hospital": 3, "fire": 2, "police": 1}
    matched: dict[int, tuple[str, str]] = {}
    for feat in feats:
        lng, lat = feat["geometry"]["coordinates"]
        kind, name = feat["properties"]["kind"], feat["properties"]["name"]
        ex, ny = lnglat_to_en(lng, lat)
        pt = shapely.Point(ex, ny)
        cand = list(sindex.query(pt, predicate="intersects"))
        if not cand:                                     # point just outside its footprint
            near = list(sindex.query(pt.buffer(40.0), predicate="intersects"))
            if near:
                cand = [min(near, key=lambda i: geoms[i].distance(pt))]
        if not cand:
            continue
        idx = int(cand[0])
        if idx not in matched or rank.get(kind, 0) > rank.get(matched[idx][0], 0):
            matched[idx] = (kind, name)

    rows_geom, rows_kind, rows_name, rows_h = [], [], [], []
    for idx, (kind, name) in matched.items():
        rows_geom.append(geoms[idx])
        rows_kind.append(kind)
        rows_name.append(name)
        rows_h.append(float(heights[idx]) if heights is not None else 12.0)
    gdf = gpd.GeoDataFrame({"kind": rows_kind, "name": rows_name, "height": rows_h},
                           geometry=rows_geom, crs="EPSG:27700").to_crs("EPSG:4326")
    out_feats = [{"type": "Feature", "geometry": mapping(g),
                  "properties": {"kind": k, "name": nm, "height": round(h, 1)}}
                 for g, k, nm, h in zip(gdf.geometry, gdf.kind, gdf.name, gdf.height)]
    with open(os.path.join(out, "emergency_buildings.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": out_feats}, f)
    return len(out_feats)


if __name__ == "__main__":
    from .config import load_config
    c = load_config()
    n = export_emergency(c)
    nb = export_emergency_buildings(c)
    print(f"wrote {n} emergency points and {nb} emergency building footprints")
