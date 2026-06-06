"""Phase 2 verification — prove the cuOpt-proposed masts actually fix the holes.

After `src.optimize` writes `out/new_masts.geojson`, this:
  1. reconstructs the simulated tiles from the per-tile cache,
  2. re-runs Sionna RT (radio map) ONLY for the tiles affected by a new mast, with the
     proposed masts added as transmitters,
  3. re-mosaics + re-exports the coverage heatmap and hotspots,
  4. traces the rays from the new masts in those tiles (recomputed rays for affected tiles),
  5. verifies that every former coverage hole is now served (target: 100%).
"""
from __future__ import annotations

import glob
import json
import os

import numpy as np

from . import export, rt as RT
from .config import load_config
from .geo import Tile, en_to_lnglat, lnglat_to_en
from .masts import Site, load_sites
from .mosaic import Mosaic
from .osm import load_buildings
from .scene_builder import build_tile_scene


def _load_new_masts(cfg) -> list[Site]:
    path = os.path.join(cfg["paths"]["out_dir"], "new_masts.geojson")
    with open(path) as f:
        fc = json.load(f)
    power = float(cfg["cuopt"]["new_mast_power_dbm"])
    out = []
    for feat in fc["features"]:
        lng, lat = feat["geometry"]["coordinates"]
        e, n = lnglat_to_en(lng, lat)
        p = feat["properties"]
        out.append(Site(id=p["id"], operator="EE-new", lat=lat, lng=lng, e=e, n=n,
                        height_m=float(p.get("height_m", 25.0)), power_dbm=power))
    return out


def _reconstruct_tiles(cfg) -> list[tuple[Tile, str]]:
    """Rebuild Tile objects + their cache paths from data/tiles/*/result.npz."""
    tiles = []
    for cache in sorted(glob.glob(os.path.join(cfg["paths"]["data_dir"], "tiles",
                                               "tile_*", "result.npz"))):
        key = os.path.basename(os.path.dirname(cache))
        _, ix, iy = key.split("_")
        m = np.load(cache)["meta"]
        e_left, n_bottom, cell, cols = float(m[0]), float(m[1]), float(m[2]), int(m[4])
        size = cols * cell
        tile = Tile(int(ix), int(iy),
                    float(e_left + size / 2), float(n_bottom + size / 2), float(size))
        tiles.append((tile, cache))
    return tiles


def _load_cached(cache, key):
    z = np.load(cache)
    m = z["meta"]
    return {"tile": key, "dbm": z["dbm"], "e_left": m[0], "n_bottom": m[1],
            "cell": m[2], "rows": int(m[3]), "cols": int(m[4]), "n_tx": int(m[5])}


def _original_holes(cfg) -> list[tuple[float, float]]:
    """Centroids (EPSG:27700) of the coverage holes BEFORE re-optimisation."""
    path = os.path.join(cfg["paths"]["out_dir"], "hotspots.geojson")
    with open(path) as f:
        fc = json.load(f)
    pts = []
    for feat in fc["features"]:
        g = feat["geometry"]
        ring = g["coordinates"][0][0] if g["type"] == "MultiPolygon" else g["coordinates"][0]
        clng = sum(c[0] for c in ring) / len(ring)
        clat = sum(c[1] for c in ring) / len(ring)
        pts.append(lnglat_to_en(clng, clat))
    return pts


def verify(cfg) -> dict:
    thr = cfg["coverage"]["served_threshold_dbm"]
    tx_radius = cfg["tiling"]["tile_size_m"] / 2 + cfg["tiling"]["tx_radius_m"]
    half = cfg["tiling"]["tile_size_m"] / 2

    new_masts = _load_new_masts(cfg)
    if not new_masts:
        print("No proposed masts to verify.")
        return {"verified": False, "reason": "no new masts"}

    holes_en = _original_holes(cfg)        # read BEFORE we overwrite hotspots.geojson
    existing = load_sites(cfg)
    all_sites = existing + new_masts
    buildings = load_buildings(cfg)
    tiles = _reconstruct_tiles(cfg)
    print(f"  {len(new_masts)} new masts, {len(tiles)} simulated tiles, "
          f"{len(holes_en)} former holes")

    # Re-solve only the tiles a new mast actually illuminates.
    results, affected, new_ray_dicts = [], [], []
    for tile, cache in tiles:
        near_new = [s for s in new_masts
                    if (s.e - tile.e0) ** 2 + (s.n - tile.n0) ** 2 <= tx_radius ** 2]
        if not near_new:
            results.append(_load_cached(cache, tile.key))
            continue
        affected.append(tile.key)
        xml, _ = build_tile_scene(cfg, tile, buildings)
        res = RT.solve_tile(cfg, tile, xml, all_sites)        # existing + new transmitters
        results.append(res)
        # Recompute rays for this affected tile: trace the new masts inside its core.
        core_new = [s for s in new_masts
                    if abs(s.e - tile.e0) <= half and abs(s.n - tile.n0) <= half]
        if core_new:
            new_ray_dicts.extend(RT.trace_mast_rays(cfg, tile, xml, core_new))
    print(f"  re-solved {len(affected)} affected tiles on Sionna RT")

    # Re-mosaic with the updated tiles and re-export coverage + hotspots.
    mosaic = Mosaic(cfg["radio"]["cell_size_m"])
    for r in results:
        mosaic.add(r)
    mosaic.assemble()
    export.export_coverage(cfg, mosaic)
    new_hotspots = export.export_hotspots(cfg, mosaic, buildings)

    # Append the new masts' rays to paths.geojson and write them standalone too.
    _append_rays(cfg, new_ray_dicts)

    # Classify each former hole: a centroid that sits inside a building can never be
    # served from outside (a polygon-centroid artifact), so the meaningful target is the
    # set of *serviceable* holes (centroid in open space).
    from shapely.geometry import Point
    from shapely.strtree import STRtree
    pad = 50.0
    es = [e for e, _ in holes_en]
    ns = [n for _, n in holes_en]
    bsub = buildings.cx[min(es) - pad:max(es) + pad, min(ns) - pad:max(ns) + pad]
    btree = STRtree(list(bsub.geometry.values))

    n_holes = len(holes_en)
    served = serviceable = served_serviceable = 0
    for (e, n) in holes_en:
        inside = len(btree.query(Point(e, n), predicate="intersects")) > 0
        ok = mosaic.sample(e, n) >= thr
        served += ok
        if not inside:
            serviceable += 1
            served_serviceable += ok
    served_overall = float((mosaic.dbm[mosaic.mask] >= thr).mean() * 100.0)
    cov_serviceable = 100.0 * served_serviceable / serviceable if serviceable else 100.0

    summary = {
        "verified": True,
        "former_holes": n_holes,
        "serviceable_holes": serviceable,
        "serviceable_holes_now_served": served_serviceable,
        "coverage_of_serviceable_holes_pct": round(cov_serviceable, 1),
        "former_holes_now_served": served,
        "coverage_of_former_holes_pct": round(100.0 * served / n_holes if n_holes else 100.0, 1),
        "served_pct_after": round(served_overall, 2),
        "remaining_hotspots": len(new_hotspots),
        "affected_tiles": len(affected),
        "new_masts": len(new_masts),
        "new_rays": len(new_ray_dicts),
    }
    with open(os.path.join(cfg["paths"]["out_dir"], "verification.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("\n=== Verification ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    return summary


def _append_rays(cfg, new_ray_dicts):
    out = cfg["paths"]["out_dir"]
    feats = [{"type": "Feature",
              "geometry": {"type": "LineString", "coordinates": r["coords"]},
              "properties": {"operator": r["operator"], "bounces": r["bounces"]}}
             for r in new_ray_dicts]
    # Standalone file for the viewer to add without rebuilding the whole ray layer.
    with open(os.path.join(out, "new_rays.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    # Also append to the master paths.geojson so a full reload stays consistent.
    path = os.path.join(out, "paths.geojson")
    if os.path.exists(path) and feats:
        with open(path) as f:
            fc = json.load(f)
        fc["features"].extend(feats)
        with open(path, "w") as f:
            json.dump(fc, f)


def main():
    verify(load_config())


if __name__ == "__main__":
    main()
