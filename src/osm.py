"""Extract 3D building footprints from the Greater London OSM extract.

Reads the Geofabrik .osm.pbf once with PyOsmium (area assembly on), pulls every
building polygon with an estimated height, reprojects to EPSG:27700, and caches the
result as a GeoDataFrame pickle for fast per-tile slicing.
"""
from __future__ import annotations

import os
import re

import geopandas as gpd
import osmium
import shapely.wkb
from shapely.geometry import box

_WKB = osmium.geom.WKBFactory()
_NUM = re.compile(r"[-+]?\d*\.?\d+")


def _parse_height(tags, default_h: float, levels_h: float) -> float:
    h = tags.get("height") or tags.get("building:height")
    if h:
        m = _NUM.search(h)
        if m:
            return float(m.group())
    lv = tags.get("building:levels")
    if lv:
        m = _NUM.search(lv)
        if m:
            return max(2.5, float(m.group()) * levels_h)
    return default_h


def _extract(pbf_path: str, default_h: float, levels_h: float) -> gpd.GeoDataFrame:
    geoms, heights = [], []
    # FileProcessor with area assembly yields Area objects for closed-way and
    # multipolygon buildings with holes resolved.
    fp = osmium.FileProcessor(pbf_path).with_areas()
    for obj in fp:
        if not isinstance(obj, osmium.osm.Area):
            continue
        if "building" not in obj.tags and "building:part" not in obj.tags:
            continue
        try:
            geom = shapely.wkb.loads(_WKB.create_multipolygon(obj), hex=True)
        except Exception:
            continue
        if geom.is_empty:
            continue
        geoms.append(geom)
        heights.append(_parse_height(obj.tags, default_h, levels_h))
    gdf = gpd.GeoDataFrame({"height": heights}, geometry=geoms, crs="EPSG:4326")
    return gdf.to_crs("EPSG:27700")


def load_buildings(cfg: dict, force: bool = False) -> gpd.GeoDataFrame:
    """Load buildings (EPSG:27700), using the on-disk pickle cache when available."""
    cache = cfg["paths"]["buildings_cache"]
    if os.path.exists(cache) and not force:
        return gpd.read_pickle(cache) if hasattr(gpd, "read_pickle") \
            else __import__("pandas").read_pickle(cache)
    b = cfg["buildings"]
    gdf = _extract(cfg["paths"]["pbf"], b["default_height_m"], b["levels_height_m"])
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    gdf.to_pickle(cache)
    return gdf


def buildings_in(gdf: gpd.GeoDataFrame, e_min, n_min, e_max, n_max) -> gpd.GeoDataFrame:
    """Buildings intersecting a 27700 bounding box (uses the spatial index)."""
    idx = list(gdf.sindex.query(box(e_min, n_min, e_max, n_max), predicate="intersects"))
    return gdf.iloc[idx]


if __name__ == "__main__":
    from .config import load_config
    c = load_config()
    g = load_buildings(c)
    print(f"{len(g)} buildings; height min/median/max = "
          f"{g.height.min():.1f}/{g.height.median():.1f}/{g.height.max():.1f} m")
    print("cache:", c["paths"]["buildings_cache"])
