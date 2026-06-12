"""Orchestrate the Greater-London coverage pipeline.

  masts + OSM buildings -> per-tile scene -> per-tile radio map (cached)
  -> mosaic -> low-coverage hotspots -> Cesium web artifacts.

Usage:
  python -m src.pipeline --subset central          # 1 central tile (fast smoke test)
  python -m src.pipeline --subset central3x3       # 3x3 tiles around the centre
  python -m src.pipeline                           # full Greater London grid (batch)
  python -m src.pipeline --limit 40 --resume       # cap tiles, reuse cached solves
"""
from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np

from . import rt as RT
from .config import load_config
from .export import export_all, export_buildings
from .geo import Tile, grid_for_bbox, tiles_for_subset
from .gpu import GpuMonitor, device_name
from .masts import load_sites, sites_in_tiles, sites_near
from .mosaic import Mosaic
from .osm import load_buildings
from .scene_builder import build_tile_scene


def _select_tiles(cfg, args) -> list[Tile]:
    ts = cfg["tiling"]["tile_size_m"]
    if args.subset:
        sub = cfg["subsets"][args.subset]
        return tiles_for_subset(sub["center"], int(sub["tiles"]), ts)
    return grid_for_bbox(cfg["bbox"], ts)


def _tile_cache(cfg, tile: Tile) -> str:
    return os.path.join(cfg["paths"]["data_dir"], "tiles", tile.key, "result.npz")


def _save_result(path, res):
    np.savez(path, dbm=res["dbm"],
             meta=np.array([res["e_left"], res["n_bottom"], res["cell"],
                            res["rows"], res["cols"], res["n_tx"]], dtype=np.float64))


def _load_result(path, key):
    z = np.load(path)
    m = z["meta"]
    return {"tile": key, "dbm": z["dbm"], "e_left": m[0], "n_bottom": m[1],
            "cell": m[2], "rows": int(m[3]), "cols": int(m[4]), "n_tx": int(m[5])}


def _pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return round(s[min(len(s) - 1, int(q * len(s)))], 1)


def _performance(monitor, tile_latencies, total_tx, mosaic, rays, ray_s, mosaic_s):
    """Assemble the performance/telemetry block shown in the viewer."""
    import mitsuba as mi
    cells = int(mosaic.mask.sum())
    gpu = monitor.summary()
    cov = {
        "tiles_solved": len(tile_latencies),
        "transmitters": total_tx,
        "mean_ms": round(sum(tile_latencies) / len(tile_latencies), 1)
        if tile_latencies else None,
        "p50_ms": _pct(tile_latencies, 0.50),
        "max_ms": round(max(tile_latencies), 1) if tile_latencies else None,
    }
    ray = {
        "count": len(rays),
        "total_s": round(ray_s, 1),
        "rays_per_s": int(len(rays) / ray_s) if ray_s > 0 else None,
    }
    return {
        "device": device_name(),
        "backend": mi.variant(),
        **gpu,
        "coverage_solve": cov,
        "radio_map_cells": cells,
        "ray_trace": ray,
        "mosaic_s": round(mosaic_s, 2),
    }


def run(args):
    t_start = time.time()
    cfg = load_config(args.config)
    # CLI overrides for radio/tiling knobs.
    if args.cell_size:
        cfg["radio"]["cell_size_m"] = args.cell_size
    if args.max_depth:
        cfg["radio"]["max_depth"] = args.max_depth

    print("Loading masts and buildings...")
    sites = load_sites(cfg)
    buildings = load_buildings(cfg)
    print(f"  {len(sites)} EE sites, {len(buildings)} buildings")

    tiles = _select_tiles(cfg, args)
    # Only simulate tiles that have at least one mast within transmitter range.
    tx_radius = cfg["tiling"]["tile_size_m"] / 2 + cfg["tiling"]["tx_radius_m"]
    tiles = [t for t in tiles if sites_near(sites, t.e0, t.n0, tx_radius)]
    if args.limit:
        tiles = tiles[:args.limit]
    print(f"  {len(tiles)} tiles to simulate")

    # The network IS the area of interest: drop every mast outside the simulated tiles.
    # No fringe-collar transmitters — boundary tiles show their honest coverage without
    # help from masts that aren't part of the modelled network.
    half = cfg["tiling"]["tile_size_m"] / 2
    n_all = len(sites)
    sites = sites_in_tiles(sites, tiles, half)
    print(f"  {len(sites)} of {n_all} masts are inside the simulated footprint")

    # Manifest of this run's tiles, so verify/optimise operate on exactly this region
    # (not whatever else is left in the per-tile cache).
    os.makedirs(cfg["paths"]["out_dir"], exist_ok=True)
    with open(os.path.join(cfg["paths"]["out_dir"], "tiles.json"), "w") as f:
        json.dump([{"key": t.key, "ix": t.ix, "iy": t.iy,
                    "e0": t.e0, "n0": t.n0, "size": t.size} for t in tiles], f)

    # GPU telemetry runs across the whole heavy compute section.
    monitor = GpuMonitor().start()
    tile_latencies = []     # per-tile radio-map solve latency (ms), fresh solves only
    total_tx = 0

    mosaic = Mosaic(cfg["radio"]["cell_size_m"])
    for i, tile in enumerate(tiles, 1):
        cache = _tile_cache(cfg, tile)
        if args.resume and os.path.exists(cache):
            res = _load_result(cache, tile.key)
            print(f"  [{i}/{len(tiles)}] {tile.key}: cached ({res['n_tx']} tx)")
        else:
            xml, nb = build_tile_scene(cfg, tile, buildings)
            t0 = time.time()
            res = RT.solve_tile(cfg, tile, xml, sites)
            if res is None:
                print(f"  [{i}/{len(tiles)}] {tile.key}: no transmitters, skipped")
                continue
            dt = time.time() - t0
            tile_latencies.append(dt * 1000.0)
            _save_result(cache, res)
            print(f"  [{i}/{len(tiles)}] {tile.key}: {nb} bldgs, {res['n_tx']} tx, "
                  f"{dt*1000:.0f} ms")
        total_tx += res["n_tx"]
        mosaic.add(res)

    print("Assembling mosaic...")
    t_mos = time.time()
    mosaic.assemble()
    mosaic_s = time.time() - t_mos

    # Ray paths out of EVERY computed mast. Each simulated tile traces all rays from the
    # masts physically inside it; combined across tiles this covers every mast in the
    # simulated footprint (bounded by a high safety cap).
    ray_cap = int(cfg["radio"].get("ray_total_cap", 500000))
    half = cfg["tiling"]["tile_size_m"] / 2
    seen, rays = set(), []
    print("Tracing all ray paths out of all computed masts...")
    t_ray = time.time()
    for tile in tiles:
        core = [s for s in sites
                if s.id not in seen
                and abs(s.e - tile.e0) <= half and abs(s.n - tile.n0) <= half]
        if not core:
            continue
        for s in core:
            seen.add(s.id)
        xml, _ = build_tile_scene(cfg, tile, buildings)
        rays.extend(RT.trace_mast_rays(cfg, tile, xml, core))
        if len(rays) >= ray_cap:
            print(f"  reached ray cap ({ray_cap}); stopping ray trace")
            break
    ray_s = time.time() - t_ray
    print(f"  {len(seen)} masts emitted {len(rays)} rays in {ray_s:.1f}s")

    monitor.stop()
    perf = _performance(monitor, tile_latencies, total_tx, mosaic, rays, ray_s, mosaic_s)

    print("Exporting web artifacts...")
    n_bldg = export_buildings(cfg, buildings, mosaic)
    print(f"  exported {n_bldg} building footprints")
    perf["wall_time_s"] = round(time.time() - t_start, 1)
    summary = export_all(cfg, mosaic, sites, rays, n_buildings=n_bldg,
                         performance=perf, buildings=buildings)
    summary["wall_time_s"] = perf["wall_time_s"]
    print("\n=== Summary ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    print(f"\nArtifacts in {cfg['paths']['out_dir']}/  ->  view them in the nemoray/ HUD")


def main():
    ap = argparse.ArgumentParser(description="Greater-London 4G coverage twin")
    ap.add_argument("--subset", choices=["central", "central3x3", "canarywharf",
                                         "battersea", "city_canary",
                                         "westminster_canary"],
                    help="named subset of tiles (default: full Greater London)")
    ap.add_argument("--limit", type=int, help="cap number of tiles")
    ap.add_argument("--cell-size", type=float, help="radio-map cell size (m)")
    ap.add_argument("--max-depth", type=int, help="max ray interactions")
    ap.add_argument("--resume", action="store_true",
                    help="reuse cached per-tile solves")
    ap.add_argument("--config", help="path to config.yaml")
    run(ap.parse_args())


if __name__ == "__main__":
    main()
